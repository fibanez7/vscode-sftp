import { ExtensionContext } from 'vscode';

// Minimal shape of vscode.SecretStorage (API >= 1.53). Declared locally because
// the pinned @types/vscode (1.40) predates it; the runtime (engine >= 1.64) has it.
interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

// VSCode SecretStorage: credentials live in the OS keychain (Keychain on macOS,
// Credential Manager on Windows, libsecret on Linux) instead of plaintext sftp.json.
let secrets: SecretStorageLike | undefined;

export type CredentialKind = 'password' | 'passphrase';

export interface CredentialTarget {
  protocol?: string;
  host?: string;
  port?: number | string;
  username?: string;
}

export function initSecretStorage(context: ExtensionContext) {
  secrets = (context as any).secrets;
}

export function isSecretStorageAvailable(): boolean {
  return secrets !== undefined;
}

// Stable key for a connection. Must be derived the same way at store time
// (command) and at read time (connect), so it only uses connection identity.
export function secretKey(
  target: CredentialTarget,
  kind: CredentialKind = 'password'
): string {
  const protocol = target.protocol || 'sftp';
  const user = target.username || '';
  const host = target.host || '';
  const port = target.port != null ? target.port : '';
  return `sftp-sync:${kind}:${protocol}://${user}@${host}:${port}`;
}

export async function getStoredCredential(
  target: CredentialTarget,
  kind: CredentialKind = 'password'
): Promise<string | undefined> {
  if (!secrets) {
    return undefined;
  }
  return secrets.get(secretKey(target, kind));
}

export async function storeCredential(
  target: CredentialTarget,
  value: string,
  kind: CredentialKind = 'password'
): Promise<void> {
  if (!secrets) {
    throw new Error('Secret storage is not available in this VS Code version.');
  }
  await secrets.store(secretKey(target, kind), value);
}

export async function deleteCredential(
  target: CredentialTarget,
  kind: CredentialKind = 'password'
): Promise<void> {
  if (!secrets) {
    return;
  }
  await secrets.delete(secretKey(target, kind));
}
