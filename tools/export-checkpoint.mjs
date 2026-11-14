// Disk-only projection: coverage is rebuilt from validated saved pairs on every run.
export function compactExportCheckpoint(progress) {
  if (!progress.raceExport) return structuredClone(progress);
  const {covered, pending, records, ...race} = progress.raceExport;
  return structuredClone({...progress, raceExport: {...race,
    records: Object.fromEntries(Object.entries(records ?? {}).filter(([, record]) => record?.available !== true))}});
}
