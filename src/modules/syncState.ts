import { ExtensionContext } from 'vscode';

// Per-file "base" = the remote file signature (mtime + size) at the last time we
// synced it. Used to detect that the remote changed out from under us before an
// upload overwrites it (a cheap, content-free conflict check à la rsync/mutagen).
//
// Stored in workspaceState so it survives reloads and is scoped per workspace.
interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

const STATE_PREFIX = 'sftp-sync:base:';

let store: MementoLike | undefined;

export interface RemoteSignature {
  mtime: number;
  size: number;
}

export function initSyncState(context: ExtensionContext) {
  store = context.workspaceState;
}

// Identity of a remote file: host + port + absolute remote path.
export function baseKey(
  remote: { host?: string; port?: number },
  remoteFsPath: string
): string {
  return `${STATE_PREFIX}${remote.host || ''}:${remote.port || ''}:${remoteFsPath}`;
}

export function getBase(key: string): RemoteSignature | undefined {
  if (!store) {
    return undefined;
  }
  return store.get<RemoteSignature>(key);
}

export function setBase(key: string, signature: RemoteSignature): Thenable<void> {
  if (!store) {
    return Promise.resolve();
  }
  return store.update(key, signature);
}

export function clearBase(key: string): Thenable<void> {
  if (!store) {
    return Promise.resolve();
  }
  return store.update(key, undefined);
}

export function signaturesEqual(
  a: RemoteSignature | undefined,
  b: RemoteSignature | undefined
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.mtime === b.mtime && a.size === b.size;
}
