function escapeHtml(value) {
  return String(value ?? '-').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function duration(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  const seconds = Math.max(0, Math.floor(Number(value) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function place(row) {
  return row?.place?.rank ? `#${row.place.rank}${row.place.fieldSize ? `/${row.place.fieldSize}` : ''}` : '-';
}

function track(row) {
  const name = row.trackName || '-';
  return `${name} (${row.trackId || '-'})`;
}

function statusClass(status) {
  return ['verified', 'waiting', 'unavailable', 'unavailable_final', 'mismatch'].includes(status) ? status : 'unknown';
}

function rowHtml(row) {
  const cells = [
    row.kind || '-', row.accountId, row.resultId, track(row), row.status, place(row),
    duration(row.waitAgeMs), row.submittedAt || '-', row.verifiedAt || '-', duration(row.verificationLatencyMs)
  ];
  return `<tr><td>${cells.slice(0, 4).map(escapeHtml).join('</td><td>')}</td><td class="status ${statusClass(row.status)}">${escapeHtml(cells[4])}</td><td>${cells.slice(5).map(escapeHtml).join('</td><td>')}</td></tr>`;
}

export function renderHtmlReport(report) {
  const scope = report?.scope || {};
  const summary = report?.summary || {};
  const rows = Array.isArray(report?.runs) ? report.runs : [];
  const generated = escapeHtml(report?.generatedAt || '-');
  const scopeText = [
    `${scope.queueDocuments ?? 0} queue docs`, `${scope.auditRecordsRead ?? 0} audit records`,
    `${scope.eventRuns ?? 0} event runs`, `bounded=${scope.truncated === true}`
  ].join(' | ');
  const summaryText = `${summary.verified ?? 0} verified | ${summary.waiting ?? 0} waiting | ${summary.published ?? 0} published | ${summary.people ?? 0} people | ${summary.tracks ?? 0} tracks`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolyTrack verifier diagnostics</title>
<style>
:root{color-scheme:light;--ink:#17202a;--muted:#5d6872;--line:#d5dce1;--paper:#f6f8f9;--accent:#126782;--good:#176b49;--warn:#8a5b10;--bad:#9b3030}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1500px;margin:0 auto;padding:28px}h1{margin:0 0 4px;font-size:26px}h2{margin:24px 0 10px;font-size:18px}.meta{color:var(--muted);margin:0 0 18px}.summary{display:flex;flex-wrap:wrap;gap:8px}.card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:10px 13px;min-width:140px}.card strong{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}.toolbar{display:flex;gap:10px;align-items:center;margin:14px 0}.toolbar input{width:min(520px,100%);border:1px solid #aeb9c1;border-radius:5px;padding:9px 10px;font:inherit}table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid var(--line);font-size:13px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#e9eef1;color:#33434d;position:sticky;top:0;white-space:nowrap}tr:last-child td{border-bottom:0}.status{font-weight:650}.verified{color:var(--good)}.waiting,.unavailable,.unavailable_final{color:var(--warn)}.mismatch{color:var(--bad)}td:nth-child(2),td:nth-child(3),td:nth-child(4){overflow-wrap:anywhere}.empty{padding:18px;color:var(--muted)}@media(max-width:900px){main{padding:16px}table{display:block;overflow-x:auto;white-space:nowrap}th{position:static}}
</style></head><body><main>
<h1>PolyTrack verifier diagnostics</h1>
<p class="meta">Generated ${generated}<br>Scope: ${escapeHtml(scopeText)}<br>${escapeHtml(summaryText)}</p>
<section class="summary" aria-label="Summary">
<div class="card"><strong>${escapeHtml(summary.verified ?? 0)}</strong><span>verified</span></div>
<div class="card"><strong>${escapeHtml(summary.waiting ?? 0)}</strong><span>waiting</span></div>
<div class="card"><strong>${escapeHtml(summary.published ?? 0)}</strong><span>published place available</span></div>
<div class="card"><strong>${escapeHtml(duration(summary.verificationLatencyMs?.averageMs))}</strong><span>average verification latency</span></div>
<div class="card"><strong>${escapeHtml(duration(summary.waitingAgeMs?.averageMs))}</strong><span>average wait duration</span></div>
</section>
<h2>Runs</h2><div class="toolbar"><label for="search">Search runs</label><input id="search" type="search" placeholder="account, run, track, status"></div>
<table id="runs"><thead><tr><th>Kind</th><th>Account ID</th><th>Run ID</th><th>Track</th><th>Status</th><th>Place</th><th>Wait duration</th><th>Submitted</th><th>Verified</th><th>Verification latency</th></tr></thead><tbody>${rows.length ? rows.map(rowHtml).join('') : '<tr><td class="empty" colspan="10">No bounded report rows.</td></tr>'}</tbody></table>
<script>(function(){const input=document.getElementById('search');const rows=[...document.querySelectorAll('#runs tbody tr')];input.addEventListener('input',function(){const query=input.value.trim().toLowerCase();rows.forEach(row=>{row.hidden=!!query&&!row.textContent.toLowerCase().includes(query);});});}());</script>
</main></body></html>`;
}

export {escapeHtml};
