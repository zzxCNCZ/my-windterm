export function filterSessions(profile, query) {
  const needle = query.trim().toLowerCase();
  const matches = (connection, group = '') => !needle || [connection.name, connection.host, connection.username, group]
    .some(value => value.toLowerCase().includes(needle));
  const groups = profile.groups.map(group => ({ ...group, connections: [] }));
  const grouped = new Map(groups.map(group => [group.id, group]));
  const loose = [];
  for (const connection of profile.connections) {
    const group = grouped.get(connection.groupId);
    if (matches(connection, group?.name)) (group?.connections || loose).push(connection);
  }
  return { loose, groups: groups.filter(group => !needle || group.connections.length || group.name.toLowerCase().includes(needle)) };
}

export function withoutGroup(profile, id) {
  return { ...profile, groups: profile.groups.filter(group => group.id !== id),
    connections: profile.connections.map(connection => connection.groupId === id ? { ...connection, groupId: null } : connection) };
}

export function restoreTabs(profile, saved) {
  const available = new Map(profile.connections.map(connection => [connection.id, connection]));
  const ids = Array.isArray(saved?.ids) ? saved.ids : [];
  const connections = [...new Set(ids)].filter(id => available.has(id)).slice(0, 24).map(id => available.get(id));
  const active = connections.some(connection => connection.id === saved?.active) ? saved.active : connections.at(-1)?.id ?? null;
  return { connections, active };
}
