export function savedDateInfo(value) {
  let date = value;
  if (typeof value?.toDate === 'function') date = value.toDate();
  else if (typeof value?.toMillis === 'function') date = new Date(value.toMillis());
  else if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const key = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
  return {
    key,
    label: date.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }),
    timestamp: date.getTime()
  };
}

export function groupTestsBySavedDate(tests) {
  const groups = new Map();
  for (const test of tests) {
    const date = savedDateInfo(test.createdAt);
    const key = date?.key || 'unavailable';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: date?.label || 'Date unavailable',
        sortTime: date?.timestamp ?? Number.NEGATIVE_INFINITY,
        tests: []
      });
    }
    groups.get(key).tests.push({ test, timestamp: date?.timestamp ?? Number.NEGATIVE_INFINITY });
  }
  return [...groups.values()]
    .sort((a, b) => b.sortTime - a.sortTime)
    .map(group => ({
      key: group.key,
      label: group.label,
      tests: group.tests
        .sort((a, b) => b.timestamp - a.timestamp
          || String(a.test.testName || '').localeCompare(String(b.test.testName || ''))
          || String(a.test.id || '').localeCompare(String(b.test.id || '')))
        .map(entry => entry.test)
    }));
}

export function canRunComparison(selectedCount) {
  return selectedCount === 3;
}
