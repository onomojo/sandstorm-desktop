import fs from 'fs';
import path from 'path';

/**
 * Parse a docker-compose.yml for top-level named networks.
 * Returns an array of { key, name } for networks with explicit `name:` properties.
 */
export function parseNamedNetworks(composeContent: string): Array<{ key: string; name: string }> {
  const results: Array<{ key: string; name: string }> = [];

  // Find the top-level `networks:` block (not indented)
  const networksMatch = composeContent.match(/^networks:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!networksMatch) return results;

  const networksBlock = networksMatch[1];

  // Find each network key (indented exactly 2 spaces) and its name property
  const keyRegex = /^  (\w[\w-]*):\s*\n((?:    .*\n?)*)/gm;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(networksBlock)) !== null) {
    const key = keyMatch[1];
    const body = keyMatch[2];
    const nameMatch = body.match(/^\s+name:\s*(.+)/m);
    if (nameMatch) {
      const name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
      results.push({ key, name });
    }
  }

  return results;
}

/**
 * Check if the sandstorm override compose file already has network overrides
 * for the given network keys using ${SANDSTORM_PROJECT}-<key> naming.
 */
export function findMissingNetworkOverrides(
  sandstormComposeContent: string,
  namedNetworks: Array<{ key: string; name: string }>,
): Array<{ key: string; name: string }> {
  return namedNetworks.filter(({ key }) => {
    const pattern = new RegExp(
      `name:\\s*\\$\\{SANDSTORM_PROJECT\\}-${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
    );
    return !pattern.test(sandstormComposeContent);
  });
}

/**
 * Auto-migrate network overrides into .sandstorm/docker-compose.yml.
 * Returns true if any changes were made.
 */
export function migrateNetworkOverrides(directory: string): boolean {
  const projectComposePath = path.join(directory, 'docker-compose.yml');
  if (!fs.existsSync(projectComposePath)) return false;

  const sandstormComposePath = path.join(directory, '.sandstorm', 'docker-compose.yml');
  if (!fs.existsSync(sandstormComposePath)) return false;

  const projectCompose = fs.readFileSync(projectComposePath, 'utf-8');
  const namedNetworks = parseNamedNetworks(projectCompose);
  if (namedNetworks.length === 0) return false;

  const sandstormCompose = fs.readFileSync(sandstormComposePath, 'utf-8');
  const missing = findMissingNetworkOverrides(sandstormCompose, namedNetworks);
  if (missing.length === 0) return false;

  const hasExistingNetworks = /^networks:\s*$/m.test(sandstormCompose);

  if (hasExistingNetworks) {
    // Append to existing networks block
    const additions = missing
      .map((n) => `  ${n.key}:\n    name: \${SANDSTORM_PROJECT}-${n.key}`)
      .join('\n');
    const updatedCompose = sandstormCompose.replace(
      /^(networks:\s*\n)/m,
      `$1${additions}\n`,
    );
    fs.writeFileSync(sandstormComposePath, updatedCompose);
  } else {
    // Add a new networks block at the end
    const networkBlock = '\nnetworks:\n' +
      missing.map((n) => `  ${n.key}:\n    name: \${SANDSTORM_PROJECT}-${n.key}`).join('\n') +
      '\n';
    const updatedCompose = sandstormCompose.trimEnd() + '\n' + networkBlock;
    fs.writeFileSync(sandstormComposePath, updatedCompose);
  }

  return true;
}
