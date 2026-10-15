import { Readable } from 'stream';
import * as fileOperations from './fileBaseOperations';
import { FileSystem, FileType } from './fs';
import { Task } from './scheduler';
import logger from '../logger';

let hasWarnedModifedTimePermission = false;

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

interface FileHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

export interface TransferOption {
  atime: number;
  mtime: number;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  backup?: boolean;
  backupLimit?: number;
}

export default class TransferTask implements Task {
  readonly fileType: FileType;
  private readonly _srcFsPath: string;
  private readonly _targetFsPath: string;
  private readonly _srcFs: FileSystem;
  private readonly _targetFs: FileSystem;
  private readonly _transferDirection: TransferDirection;
  private readonly _TransferOption: TransferOption;
  private _handle: Readable;
  private _cancelled: boolean;
  // private _fileStatus: FileStatus;

  constructor(
    src: FileHandle,
    target: FileHandle,
    option: {
      fileType: FileType;
      transferDirection: TransferDirection;
      transferOption: TransferOption;
    }
  ) {
    this._srcFsPath = src.fsPath;
    this._targetFsPath = target.fsPath;
    this._srcFs = src.fileSystem;
    this._targetFs = target.fileSystem;
    this._TransferOption = option.transferOption;
    this._transferDirection = option.transferDirection;
    this.fileType = option.fileType;
  }

  get localFsPath() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      return this._targetFsPath;
    } else {
      return this._srcFsPath;
    }
  }

  get srcFsPath() {
    return this._srcFsPath;
  }

  get targetFsPath() {
    return this._targetFsPath;
  }

  get transferType() {
    return this._transferDirection;
  }

  async run() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    switch (this.fileType) {
      case FileType.File:
        await this._transferFile();
        break;
      case FileType.SymbolicLink:
        await fileOperations.transferSymlink(
          src,
          target,
          srcFs,
          targetFs,
          this._TransferOption
        );
        break;
      default:
        logger.warn(`Unsupported file type (type = ${this.fileType}). File ${src}`);
    }
  }

  cancel() {
    if (this._handle && !this._cancelled) {
      this._cancelled = true;
      FileSystem.abortReadableStream(this._handle);
    }
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  private async _transferFile() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      useTempFile,
      openSsh,
      fallbackMode,
      atime,
      mtime,
      filePerm,
      backup
    } = this._TransferOption;
    // Set the mode if it's specified in the config, otherwise get mode from server.
    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    let targetFd; // Destination file
    let uploadFd; // Temp file or destination file when no temp file is used
    const uploadTarget = target + (useTempFile ? ".new" : "");

    // Back up the target before it gets overwritten. Done before any open/write
    // so the previous content is always preserved, even with a non-temp upload.
    if (backup) {
      await this._backupTarget(targetFs, target);
    }

    // Use mode first.
    // Then check perserveTargetMode and fallback to fallbackMode if fail to get mode of target
    if (mode === undefined && perserveTargetMode) {
      if (useTempFile) {
        [targetFd, uploadFd] = await Promise.all([
          targetFs.open(target, 'r')  // Get handle for reading the target mode
            .catch(() => null), // Return null if target file doesn't exist
          targetFs.open(uploadTarget, 'w')  // Get handle for the file upload
        ]);
      } else {
        targetFd = uploadFd = await targetFs.open(uploadTarget, 'w');
      }

      if (targetFd) {
        [this._handle, mode] = await Promise.all([
          srcFs.get(src),
          targetFs
            .fstat(targetFd)
            .then(stat => stat.mode)
            .catch(() => fallbackMode),
        ]);

        if (useTempFile) {
          targetFs.close(targetFd);
        }

      } else {
        this._handle = await srcFs.get(src);
        mode = fallbackMode;
      }

    } else {
      [this._handle, uploadFd] = await Promise.all([
        srcFs.get(src),
        targetFs.open(uploadTarget, 'w'),
      ]);
    }

    try {
      if (useTempFile) {
        logger.info("uploading temp file: " + uploadTarget);
      }
      await targetFs.put(this._handle, uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });
      if (atime && mtime) {
        try {
          await targetFs.futimes(
            uploadFd,
            Math.floor(atime / 1000),
            Math.floor(mtime / 1000)
          );
        } catch (error) {
          if (!hasWarnedModifedTimePermission) {
            hasWarnedModifedTimePermission = true;
            logger.warn(
              `Can't set modified time to the file because ${error.message}`
            );
          }
        }
      }

      if (useTempFile) {
        logger.info("moving from: " + target + ".new" + " to: " + target);
        if(openSsh) {
          await targetFs.renameAtomic(uploadTarget, target);
        } else {
          try {
            await targetFs.unlink(target);
          } catch(error) {
            // Just ignore
          }
          await targetFs.rename(uploadTarget, target);
        }
      }

    } finally {
      await targetFs.close(uploadFd);
    }
  }

  // Move the existing target into a sibling `.sftp-backups` directory with a
  // timestamped name. Best-effort: a failed backup is logged but does not abort
  // the upload (the warning is surfaced to the user via the output channel).
  private async _backupTarget(targetFs: FileSystem, target: string): Promise<void> {
    let exists = true;
    try {
      await targetFs.lstat(target);
    } catch (error) {
      exists = false;
    }
    if (!exists) {
      return;
    }

    const dirname = targetFs.pathResolver.dirname(target);
    const basename = targetFs.pathResolver.basename(target);
    const backupDir = targetFs.pathResolver.join(dirname, '.sftp-backups');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = targetFs.pathResolver.join(
      backupDir,
      `${basename}.${timestamp}.bak`
    );

    try {
      await targetFs.ensureDir(backupDir);
      await targetFs.rename(target, backupPath);
      logger.info(`backup: ${target} -> ${backupPath}`);
      await this._pruneBackups(targetFs, backupDir, basename);
    } catch (error) {
      logger.warn(`backup failed for ${target}: ${error.message}`);
    }
  }

  // Keep only the most recent `backupLimit` backups for this file. Backup names
  // end in an ISO timestamp, so a lexicographic sort is chronological.
  private async _pruneBackups(
    targetFs: FileSystem,
    backupDir: string,
    basename: string
  ): Promise<void> {
    const limit = this._TransferOption.backupLimit;
    if (!limit || limit <= 0) {
      return;
    }

    const prefix = `${basename}.`;
    const entries = await targetFs.list(backupDir);
    const mine = entries
      .map(entry => entry.name)
      .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
      .sort();

    const excess = mine.length - limit;
    for (let i = 0; i < excess; i++) {
      const stale = targetFs.pathResolver.join(backupDir, mine[i]);
      try {
        await targetFs.unlink(stale);
        logger.info(`backup pruned: ${stale}`);
      } catch (error) {
        logger.warn(`backup prune failed for ${stale}: ${error.message}`);
      }
    }
  }
}
