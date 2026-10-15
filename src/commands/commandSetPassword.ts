import * as vscode from 'vscode';
import { COMMAND_SET_PASSWORD } from '../constants';
import { showInformationMessage, showWarningMessage } from '../host';
import logger from '../logger';
import { getAllFileService } from '../modules/serviceManager';
import {
  isSecretStorageAvailable,
  storeCredential,
  deleteCredential,
  CredentialTarget,
} from '../modules/secret';
import { checkCommand } from './abstract/createCommand';

interface ConnectionItem extends vscode.QuickPickItem {
  target: CredentialTarget;
}

function collectConnections(): ConnectionItem[] {
  const items: ConnectionItem[] = [];
  const seen = new Set<string>();

  getAllFileService().forEach(service => {
    const profiles = service.getAvailableProfiles();
    const configs =
      profiles.length > 0
        ? profiles.map(profile => {
            try {
              return service.getConfig(profile);
            } catch (error) {
              logger.warn(`skip profile "${profile}": ${error.message}`);
              return undefined;
            }
          })
        : [
            (() => {
              try {
                return service.getConfig();
              } catch (error) {
                logger.warn(`skip config: ${error.message}`);
                return undefined;
              }
            })(),
          ];

    configs.forEach(config => {
      if (!config || config.protocol === 'local' || !config.host) {
        return;
      }

      const target: CredentialTarget = {
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        username: config.username,
      };
      const detail = `${target.username || ''}@${target.host}:${target.port}`;
      const dedupeKey = `${target.protocol}|${detail}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      items.push({
        label: service.name || target.host || detail,
        description: detail,
        target,
      });
    });
  });

  return items;
}

export default checkCommand({
  id: COMMAND_SET_PASSWORD,

  async handleCommand() {
    if (!isSecretStorageAvailable()) {
      showWarningMessage(
        'Secret storage is not available in this VS Code version.'
      );
      return;
    }

    const connections = collectConnections();
    if (connections.length <= 0) {
      showInformationMessage(
        'No SFTP/FTP connection found. Create a sftp.json config first.'
      );
      return;
    }

    const picked =
      connections.length === 1
        ? connections[0]
        : await vscode.window.showQuickPick(connections, {
            placeHolder: 'Select a connection',
          });
    if (!picked) {
      return;
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: 'Set password', value: 'set-password' },
        { label: 'Set passphrase (for private key)', value: 'set-passphrase' },
        { label: 'Clear stored credentials', value: 'clear' },
      ],
      { placeHolder: `${picked.label} (${picked.description})` }
    );
    if (!action) {
      return;
    }

    if (action.value === 'clear') {
      await deleteCredential(picked.target, 'password');
      await deleteCredential(picked.target, 'passphrase');
      showInformationMessage(`Cleared stored credentials for ${picked.label}.`);
      return;
    }

    const kind = action.value === 'set-passphrase' ? 'passphrase' : 'password';
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      prompt: `Enter ${kind} for ${picked.label} (${picked.description})`,
    });
    if (secret === undefined) {
      return;
    }

    await storeCredential(picked.target, secret, kind);
    showInformationMessage(
      `Saved ${kind} for ${picked.label} to the OS keychain.`
    );
  },
});
