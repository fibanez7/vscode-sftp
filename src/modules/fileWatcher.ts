import * as fs from 'fs';
import * as vscode from 'vscode';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import { isValidFile, fileDepth } from '../helper';
import { upload, removeRemote } from '../fileHandlers';
import { WatcherService } from '../core';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { getRunningTransformTasks } from './serviceManager';

const watchers: {
  [x: string]: vscode.FileSystemWatcher;
} = {};

// keyed by fsPath: vscode.Uri instances for the same file are not equal
const uploadQueue = new Map<string, vscode.Uri>();
const deleteQueue = new Map<string, vscode.Uri>();

// less than 550 will not work
const ACTION_INTEVAL = 550;

// The OS watcher (notably on Windows) often reports the same change twice,
// ~1s apart, which escapes the debounce. Skip a repeat of the same action on
// the same file within this window.
const DUPLICATE_WINDOW = 3000;
const recentUploads = new Map<string, { at: number; signature: string }>();
const recentDeletes = new Map<string, number>();

function fileSignature(fsPath: string): string {
  try {
    const stat = fs.statSync(fsPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

function isDuplicateUpload(fsPath: string): boolean {
  const signature = fileSignature(fsPath);
  const last = recentUploads.get(fsPath);
  const now = Date.now();
  recentUploads.set(fsPath, { at: now, signature });
  // only a duplicate if the file did not change since the last upload
  return !!last && signature !== '' && last.signature === signature && now - last.at < DUPLICATE_WINDOW;
}

// Files the extension just transferred: written by a download (downloadOnOpen,
// sync remote ➞ local...) or already uploaded (uploadOnSave, commands...).
// The watcher still sees those as local changes; uploading again would only
// send the same content, so skip while the file is unchanged since then.
const synced = new Map<string, string>();

export function markSynced(fsPath: string) {
  const signature = fileSignature(fsPath);
  if (signature) {
    synced.set(fsPath, signature);
  }
}

function isUnchangedSinceSync(fsPath: string): boolean {
  const signature = synced.get(fsPath);
  if (signature === undefined) {
    return false;
  }
  if (signature === fileSignature(fsPath)) {
    return true;
  }
  // edited locally since: upload normally
  synced.delete(fsPath);
  return false;
}

function isDuplicateDelete(fsPath: string): boolean {
  const last = recentDeletes.get(fsPath);
  const now = Date.now();
  recentDeletes.set(fsPath, now);
  return last !== undefined && now - last < DUPLICATE_WINDOW && !fs.existsSync(fsPath);
}

function doUpload() {
  const files = Array.from(uploadQueue.values()).sort((a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath));
  uploadQueue.clear();

  const runningTasks = getRunningTransformTasks();

  files.forEach(async uri => {
    // target is still being downloaded/uploaded: don't upload it again.
    if (runningTasks.find(task => task.localFsPath === uri.fsPath)) {
      return;
    }

    const fspath = uri.fsPath;
    if (isUnchangedSinceSync(fspath) || isDuplicateUpload(fspath)) {
      return;
    }
    logger.info(`[watcher/updated] ${fspath}`);
    try {
      await upload(uri);
    } catch (error) {
      logger.error(error, `upload ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

function doDelete() {
  const files = Array.from(deleteQueue.values()).sort((a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath));
  deleteQueue.clear();
  files.forEach(async uri => {
    const fspath = uri.fsPath;
    if (isDuplicateDelete(fspath)) {
      return;
    }
    logger.info(`[watcher/removed] ${fspath}`);
    try {
      await removeRemote(uri);
    } catch (error) {
      logger.error(error, `remove ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

// trailing only: gives a concurrent download/uploadOnSave time to register its task
const debouncedUpload = debounce(doUpload, ACTION_INTEVAL, { leading: false, trailing: true });
const debouncedDelete = debounce(doDelete, ACTION_INTEVAL, { leading: true, trailing: true });

function uploadHandler(uri: vscode.Uri) {
  if (!isValidFile(uri)) {
    return;
  }

  uploadQueue.set(uri.fsPath, uri);
  debouncedUpload();
}

function changeHandler(uri: vscode.Uri) {
  // Windows reports a folder as "changed" whenever an entry inside it is
  // created/renamed/deleted. That must not re-upload the whole folder: the
  // entries themselves get their own create/change events.
  try {
    if (fs.statSync(uri.fsPath).isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  uploadHandler(uri);
}

function addWatcher(id, watcher) {
  watchers[id] = watcher;
}

function getWatcher(id) {
  return watchers[id];
}

function createWatcher(
  watcherBase: string,
  watcherConfig: { files: false | string; autoUpload: boolean; autoDelete: boolean }
) {
  let watcher = getWatcher(watcherBase);
  if (watcher) {
    // clear old watcher
    watcher.dispose();
  }

  if (!watcherConfig) {
    return;
  }

  const shouldAddListenser = watcherConfig.autoUpload || watcherConfig.autoDelete;
  // tslint:disable-next-line triple-equals
  if (watcherConfig.files == false || !shouldAddListenser) {
    return;
  }

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(watcherBase, watcherConfig.files),
    false,
    false,
    false
  );
  addWatcher(watcherBase, watcher);

  if (watcherConfig.autoUpload) {
    watcher.onDidCreate(uploadHandler);
    watcher.onDidChange(changeHandler);
  }

  if (watcherConfig.autoDelete) {
    watcher.onDidDelete(uri => {
      if (!isValidFile(uri)) {
        return;
      }

      deleteQueue.set(uri.fsPath, uri);
      debouncedDelete();
    });
  }
}

function removeWatcher(watcherBase: string) {
  const watcher = getWatcher(watcherBase);
  if (watcher) {
    watcher.dispose();
    delete watchers[watcherBase];
  }
}

const watcherService: WatcherService = {
  create: createWatcher,
  dispose: removeWatcher,
};

export default watcherService;
