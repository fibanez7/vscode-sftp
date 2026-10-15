import { refreshRemoteExplorer } from './shared';
import { fileOperations, FileType } from '../core';
import createFileHandler from './createFileHandler';
import { FileHandleOption } from './option';
import logger from '../logger';

export const removeRemote = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'removeRemote',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;
    let stat;
    try {
      stat = await remoteFs.lstat(remoteFsPath);
    } catch (error) {
      // already gone remotely (e.g. a local delete made by "sync remote ➞ local"):
      // nothing to remove. SFTP reports code 2 (NO_SUCH_FILE).
      if (error.code === 2 || error.code === 'ENOENT') {
        logger.info(`[skip] remove (not on remote) ${remoteFsPath}`);
        return;
      }
      throw error;
    }
    let promise;
    switch (stat.type) {
      case FileType.Directory:
        if (option.skipDir) {
          return;
        }

        promise = fileOperations.removeDir(remoteFsPath, remoteFs, {});
        break;
      case FileType.File:
      case FileType.SymbolicLink:
        promise = fileOperations.removeFile(remoteFsPath, remoteFs, {});
        break;
      default:
        logger.warn(`Unsupported file type (type = ${stat.type}). File ${remoteFsPath}`);
    }
    await promise;
  },
  transformOption() {
    const config = this.config;
    return {
      ignore: config.uploadIgnore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});
