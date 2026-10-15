import * as vscode from 'vscode';
import { refreshRemoteExplorer } from '../shared';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';
import logger from '../../logger';
import {
  baseKey,
  getBase,
  setBase,
  signaturesEqual,
  RemoteSignature,
} from '../../modules/syncState';
import { transfer, sync, TransferOption, SyncOption, TransferDirection } from './transfer';

// --- Remote-change protection (opt-in via config.checkRemoteChanges) ---------
// Cheap, content-free conflict check: compare the remote file's mtime+size
// against the signature stored at our last sync. If it changed out from under
// us, warn before an upload overwrites it. Scoped to single-file operations
// (upload-on-save / Upload File) so bulk folder/project uploads pay no cost.

async function getRemoteSignature(
  ctx: FileHandlerContext
): Promise<RemoteSignature | null> {
  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
  try {
    const stat = await remoteFs.lstat(ctx.target.remoteFsPath);
    return { mtime: stat.mtime, size: stat.size };
  } catch (error) {
    // Remote file doesn't exist (or can't be stat'd) — nothing to clobber.
    return null;
  }
}

function signatureKey(ctx: FileHandlerContext): string {
  return baseKey(
    { host: ctx.config.host, port: ctx.config.port },
    ctx.target.remoteFsPath
  );
}

// Returns true if the upload should proceed.
async function guardRemoteConflict(ctx: FileHandlerContext): Promise<boolean> {
  if (!ctx.config.checkRemoteChanges) {
    return true;
  }

  const sig = await getRemoteSignature(ctx);
  if (!sig) {
    return true; // new remote file
  }

  const base = getBase(signatureKey(ctx));
  if (!base) {
    return true; // no baseline yet — first sync, recorded after upload
  }
  if (signaturesEqual(sig, base)) {
    return true; // remote unchanged since last sync — safe
  }

  const choice = await vscode.window.showWarningMessage(
    `Remote file "${ctx.target.remoteFsPath}" changed since your last sync. ` +
      `Uploading will overwrite those changes. ` +
      `(Use "SFTP: Diff with Remote" to compare first.)`,
    'Overwrite',
    'Cancel'
  );
  return choice === 'Overwrite';
}

// Persist the current remote signature as the new sync baseline.
async function recordRemoteBase(ctx: FileHandlerContext): Promise<void> {
  if (!ctx.config.checkRemoteChanges) {
    return;
  }
  try {
    const sig = await getRemoteSignature(ctx);
    if (sig) {
      await setBase(signatureKey(ctx), sig);
    }
  } catch (error) {
    logger.warn(`failed to record sync base: ${error.message}`);
  }
}

function createTransferHandle(direction: TransferDirection) {
  return async function handle(this: FileHandlerContext, option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
    let transferConfig;

    if (direction === TransferDirection.REMOTE_TO_LOCAL) {
      transferConfig = {
        srcFsPath: remoteFsPath,
        srcFs: remoteFs,
        targetFsPath: localFsPath,
        targetFs: localFs,
        transferOption: option,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      };
    } else {
      transferConfig = {
        srcFsPath: localFsPath,
        srcFs: localFs,
        targetFsPath: remoteFsPath,
        targetFs: remoteFs,
        transferOption: option,
        filePerm: this.config.filePerm,
        dirPerm: this.config.dirPerm,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      };
    }
    // todo: abort at here. we should stop collect task
    await transfer(transferConfig, t => scheduler.add(t));
    await scheduler.run();
  };
}

const uploadHandle = createTransferHandle(TransferDirection.LOCAL_TO_REMOTE);
const downloadHandle = createTransferHandle(TransferDirection.REMOTE_TO_LOCAL);

export const sync2Remote = createFileHandler<SyncOption>({
  name: 'sync local ➞ remote',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
    // Attach filePerm and dirPerm to transferOption
    option.filePerm = this.config.filePerm;
    option.dirPerm = this.config.dirPerm;
    await sync(
      {
        srcFsPath: localFsPath,
        srcFs: localFs,
        targetFsPath: remoteFsPath,
        targetFs: remoteFs,
        transferOption: option,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      },
      t => scheduler.add(t)
    );
    await scheduler.run();
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      backup: config.backup,
      backupLimit: config.backupLimit,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const sync2Local = createFileHandler<SyncOption>({
  name: 'sync remote ➞ local',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
    await sync(
      {
        srcFsPath: remoteFsPath,
        srcFs: remoteFs,
        targetFsPath: localFsPath,
        targetFs: localFs,
        transferOption: option,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      },
      t => scheduler.add(t)
    );
    await scheduler.run();
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
    };
  },
});

export const upload = createFileHandler<TransferOption>({
  name: 'upload',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      backup: config.backup,
      backupLimit: config.backupLimit,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, this.fileService);
  },
});

export const uploadFile = createFileHandler<TransferOption>({
  name: 'upload file',
  async handle(option) {
    const proceed = await guardRemoteConflict(this);
    if (!proceed) {
      logger.info(`upload skipped (remote changed): ${this.target.remoteFsPath}`);
      return;
    }
    await uploadHandle.call(this, option);
    await recordRemoteBase(this);
  },
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      backup: config.backup,
      backupLimit: config.backupLimit,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const uploadFolder = createFileHandler<TransferOption>({
  name: 'upload folder',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      backup: config.backup,
      backupLimit: config.backupLimit,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const download = createFileHandler<TransferOption>({
  name: 'download',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});

export const downloadFile = createFileHandler<TransferOption>({
  name: 'download file',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    // Record the just-downloaded remote version as the sync baseline so a later
    // upload knows whether the remote changed again.
    recordRemoteBase(this);
  },
});

export const downloadFolder = createFileHandler<TransferOption>({
  name: 'download folder',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});
