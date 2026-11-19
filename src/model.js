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
  const recorded = Array.isArray(saved?.tabs) ? saved.tabs
    : Array.isArray(saved?.ids) ? saved.ids.map(id => ({ id, connectionId: id })) : [];
  const tabs = [];
  const seen = new Set();
  for (const item of recorded) {
    const connection = available.get(item?.connectionId);
    if (!connection || typeof item.id !== 'string' || seen.has(item.id)) continue;
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(item.id)) continue;
    tabs.push({ id: item.id, connection });
    seen.add(item.id);
    if (tabs.length === 24) break;
  }
  return { tabs, active: seen.has(saved?.active) ? saved.active : tabs.at(-1)?.id ?? null };
}

export function savedTabs(sessions, active) {
  return { tabs: [...sessions].map(session => ({ id: session.id, connectionId: session.connection.id })), active };
}

export function connectionTabs(sessions, connectionId) {
  return [...sessions].filter(session => session.connection.id === connectionId);
}
