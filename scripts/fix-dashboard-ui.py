#!/usr/bin/env python3
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "public/index.html"
t = P.read_text(encoding="utf-8")

# escAttr helper
if "function escAttr" not in t:
    t = t.replace(
        "function escHtml(s) {\n  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\"/g,'&quot;');\n}",
        "function escHtml(s) {\n  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\"/g,'&quot;');\n}\nfunction escAttr(s) {\n  return escHtml(s).replace(/'/g, '&#39;');\n}\nfunction phoneDigits(s) {\n  return String(s || '').replace(/\\D/g, '');\n}",
        1,
    )

# CSS
if ".name-link" not in t:
    t = t.replace(
        "tr:hover td{background:var(--surface2)}",
        "tr:hover td{background:var(--surface2)}\n.name-link{cursor:pointer;color:var(--primary);background:none;border:none;padding:0;font:inherit;font-weight:600;text-align:left}\n.name-link:hover{text-decoration:underline}",
        1,
    )

# dup pager slot
if 'id="dup-pager"' not in t:
    t = t.replace(
        '<p style="font-size:12px;color:var(--muted);margin-bottom:10px">Ces numéros figurent dans l\'historique global. Cochez ceux à réimporter quand même.</p>',
        '<p style="font-size:12px;color:var(--muted);margin-bottom:10px">Ces numéros figurent dans l\'historique global. Cochez ceux à réimporter quand même.</p>\n          <div id="dup-pager" style="display:none;gap:8px;align-items:center;margin-bottom:10px;font-size:12px;color:var(--muted)"></div>',
        1,
    )

# showPage guard
t = t.replace(
    """function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  el.classList.add('active');""",
    """function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pageEl = document.getElementById('page-'+name);
  if (!pageEl) return;
  pageEl.classList.add('active');
  if (el) el.classList.add('active');
  else {
    const nav = document.querySelector(`.nav-item[onclick*="showPage('${name}'"]`);
    if (nav) nav.classList.add('active');
  }""",
    1,
)

# dup state vars near pendingCSVFiles
if "let dupPage" not in t:
    t = t.replace(
        "let pendingCSVFiles = [];",
        "let pendingCSVFiles = [];\nlet dupPage = 1, dupListCache = [];\nconst DUP_PER_PAGE = 50;\nlet queueTableBound = false;",
        1,
    )

# renderQueue replacement
OLD_RQ = """function renderQueue() {
  let filtered = queueData;
  if (queueFilter !== 'all') {
    if (queueFilter === 'replied') filtered = filtered.filter(c => c.replied === true);
    else filtered = filtered.filter(c => c.status === queueFilter);
  }
  if (queueSearch) filtered = filtered.filter(c=>
    String(c.phone||c.telephone||'').includes(queueSearch) ||
    String(c.prenom||c.name||'').toLowerCase().includes(queueSearch) ||
    String(c.nom||'').toLowerCase().includes(queueSearch)
  );

  const total = filtered.length;
  document.getElementById('queue-count-label').textContent = `${total} contact${total>1?'s':''}`;

  const pages = Math.ceil(total/Q_PER_PAGE)||1;
  const page = filtered.slice((queuePage-1)*Q_PER_PAGE, queuePage*Q_PER_PAGE);

  const tbody = document.getElementById('queue-table');
  if (!page.length) {
    tbody.innerHTML=`<tr><td colspan="7"><div class="empty-state"><div style="font-size:32px">🔍</div><p>Aucun contact pour ce filtre.</p></div></td></tr>`;
  } else {
    tbody.innerHTML = page.map(c=>{
      const phone = c.phone||c.telephone||'';
      const prenom = c.prenom||c.name||'';
      const nom = c.nom||'';
      const shortMsg = (c.message||'').substring(0,40)+(c.message&&c.message.length>40?'…':'');
      const sentAt = c.sentAt ? new Date(c.sentAt).toLocaleString('fr-FR') : '—';
      const replyTitle = (c.replyText||'').replace(/"/g,'&quot;');
      const repliedCell = c.replied
        ? `<span class="badge badge-blue" title="${replyTitle}">💬 Oui</span>${c.replyText?`<span style="display:block;font-size:10px;color:var(--muted);margin-top:2px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.replyText.substring(0,28)}${c.replyText.length>28?'…':''}</span>`:''}`
        : '<span style="color:var(--faint)">—</span>';
      return `<tr>
        <td style="font-family:monospace;font-size:12px">${phone}</td>
        <td>${prenom?`<strong>${prenom}</strong>${nom?' '+nom:''}`:'-'}</td>
        <td>${statusBadge(c.status||'pending')}</td>
        <td style="max-width:140px">${repliedCell}</td>
        <td style="color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(c.message||'').replace(/"/g,'&quot;')}">${shortMsg||'—'}</td>
        <td style="font-size:11px;color:var(--muted)">${sentAt}</td>
        <td><button class="btn btn-danger" style="padding:3px 8px;font-size:11px" onclick="removeQueueContact('${phone}')">🗑</button></td>
      </tr>`;
    }).join('');
  }

  const pg = document.getElementById('queue-pagination');
  if (pages <= 1) { pg.innerHTML=''; return; }
  let html='';
  if (queuePage>1) html+=`<button class="btn btn-ghost" style="padding:5px 10px;font-size:12px" onclick="goQueuePage(${queuePage-1})">← Préc</button>`;
  html+=`<span style="font-size:12px;color:var(--muted);align-self:center">Page ${queuePage} / ${pages}</span>`;
  if (queuePage<pages) html+=`<button class="btn btn-ghost" style="padding:5px 10px;font-size:12px" onclick="goQueuePage(${queuePage+1})">Suiv →</button>`;
  pg.innerHTML=html;
}"""

NEW_RQ = """function bindQueueTableEvents() {
  if (queueTableBound) return;
  const tbody = document.getElementById('queue-table');
  if (!tbody) return;
  queueTableBound = true;
  tbody.addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-action="queue-remove"]');
    if (rm) { removeQueueContact(rm.dataset.phone); return; }
    const nm = ev.target.closest('[data-action="queue-filter-name"]');
    if (nm) {
      queueSearch = (nm.dataset.term || '').toLowerCase();
      document.getElementById('queue-search').value = nm.dataset.term || '';
      queuePage = 1;
      renderQueue();
    }
  });
}

function renderQueue() {
  bindQueueTableEvents();
  let filtered = queueData;
  if (queueFilter !== 'all') {
    if (queueFilter === 'replied') filtered = filtered.filter(c => c.replied === true);
    else filtered = filtered.filter(c => c.status === queueFilter);
  }
  if (queueSearch) filtered = filtered.filter(c=>
    String(c.phone||c.telephone||'').includes(queueSearch) ||
    String(c.prenom||c.name||'').toLowerCase().includes(queueSearch) ||
    String(c.nom||'').toLowerCase().includes(queueSearch)
  );

  const total = filtered.length;
  document.getElementById('queue-count-label').textContent = `${total} contact${total>1?'s':''}`;

  const pages = Math.ceil(total/Q_PER_PAGE)||1;
  if (queuePage > pages) queuePage = pages;
  const page = filtered.slice((queuePage-1)*Q_PER_PAGE, queuePage*Q_PER_PAGE);

  const tbody = document.getElementById('queue-table');
  if (!page.length) {
    tbody.innerHTML=`<tr><td colspan="7"><div class="empty-state"><div style="font-size:32px">🔍</div><p>Aucun contact pour ce filtre.</p></div></td></tr>`;
  } else {
    tbody.innerHTML = page.map(c=>{
      const phone = phoneDigits(c.phone||c.telephone||'');
      const prenom = c.prenom||c.name||'';
      const nom = c.nom||'';
      const nameLabel = [prenom, nom].filter(Boolean).join(' ').trim() || '—';
      const nameTerm = (prenom || nom || phone).trim();
      const shortMsg = escHtml((c.message||'').substring(0,40)+(c.message&&c.message.length>40?'…':''));
      const sentAt = c.sentAt ? new Date(c.sentAt).toLocaleString('fr-FR') : '—';
      const replyTitle = escAttr(c.replyText||'');
      const replyShort = escHtml(c.replyText ? (c.replyText.substring(0,28)+(c.replyText.length>28?'…':'')) : '');
      const repliedCell = c.replied
        ? `<span class="badge badge-blue" title="${replyTitle}">💬 Oui</span>${c.replyText?`<span style="display:block;font-size:10px;color:var(--muted);margin-top:2px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${replyShort}</span>`:''}`
        : '<span style="color:var(--faint)">—</span>';
      const nameCell = nameLabel === '—' ? '—' : `<button type="button" class="name-link" data-action="queue-filter-name" data-term="${escAttr(nameTerm)}">${escHtml(nameLabel)}</button>`;
      return `<tr>
        <td style="font-family:monospace;font-size:12px">${escHtml(phone)}</td>
        <td>${nameCell}</td>
        <td>${statusBadge(c.status||'pending')}</td>
        <td style="max-width:140px">${repliedCell}</td>
        <td style="color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(c.message||'')}">${shortMsg||'—'}</td>
        <td style="font-size:11px;color:var(--muted)">${escHtml(sentAt)}</td>
        <td><button type="button" class="btn btn-danger" style="padding:3px 8px;font-size:11px" data-action="queue-remove" data-phone="${escAttr(phone)}">🗑</button></td>
      </tr>`;
    }).join('');
  }

  const pg = document.getElementById('queue-pagination');
  if (pages <= 1) { pg.innerHTML=''; return; }
  let html='';
  if (queuePage>1) html+=`<button class="btn btn-ghost" style="padding:5px 10px;font-size:12px" onclick="goQueuePage(${queuePage-1})">← Préc</button>`;
  html+=`<span style="font-size:12px;color:var(--muted);align-self:center">Page ${queuePage} / ${pages}</span>`;
  if (queuePage<pages) html+=`<button class="btn btn-ghost" style="padding:5px 10px;font-size:12px" onclick="goQueuePage(${queuePage+1})">Suiv →</button>`;
  pg.innerHTML=html;
}"""

if OLD_RQ not in t:
    raise SystemExit("renderQueue block not found")
t = t.replace(OLD_RQ, NEW_RQ, 1)

# showDuplicatePanel + helpers
OLD_SHOW_DUP = """function showDuplicatePanel(duplicates) {
  const seen = new Set();
  const unique = [];
  for (const d of duplicates) {
    const p = (d.phone || '').replace(/\\D/g, '');
    if (!p || seen.has(p)) continue;
    seen.add(p);
    unique.push({ ...d, phone: p });
  }
  pendingImportContext.duplicates = unique;
  const tbody = document.getElementById('dup-table');
  tbody.innerHTML = unique.map(d => {
    const sent = d.lastSentAt || d.sentAt;
    const sentStr = sent ? new Date(sent).toLocaleString('fr-FR') : '—';
    const bot = (d.lastBotId || d.botId) ? `N°${d.lastBotId || d.botId}` : '—';
    const count = d.contactCount || 1;
    const why = msgSummary(d.lastMessage || d.message, 50);
    const detail = (d.contacts && d.contacts.length > 1)
      ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${d.contacts.length} envois enregistrés</div>` : '';
    return `<tr>
      <td><input type="checkbox" class="dup-cb" value="${d.phone}" checked></td>
      <td style="font-family:monospace;font-size:12px">${d.phone}</td>
      <td>${escHtml(d.prenom || '—')} ${escHtml(d.nom || '')}</td>
      <td><span class="badge badge-yellow">${count}×</span></td>
      <td style="max-width:200px;font-size:11px" title="${escHtml(d.lastMessage||'')}">${escHtml(why)}${detail}</td>
      <td style="font-size:11px;color:var(--muted)">${sentStr}</td>
      <td>${bot}</td>
    </tr>`;
  }).join('');
  document.getElementById('dup-select-all').checked = true;
  document.getElementById('dup-confirm-box').style.display = 'block';
  document.getElementById('dup-confirm-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}"""

NEW_SHOW_DUP = """function renderDupTablePage() {
  const tbody = document.getElementById('dup-table');
  const pages = Math.ceil(dupListCache.length / DUP_PER_PAGE) || 1;
  if (dupPage > pages) dupPage = pages;
  const slice = dupListCache.slice((dupPage - 1) * DUP_PER_PAGE, dupPage * DUP_PER_PAGE);
  tbody.innerHTML = slice.map(d => {
    const sent = d.lastSentAt || d.sentAt;
    const sentStr = sent ? new Date(sent).toLocaleString('fr-FR') : '—';
    const bot = (d.lastBotId || d.botId) ? `N°${d.lastBotId || d.botId}` : '—';
    const count = d.contactCount || 1;
    const why = msgSummary(d.lastMessage || d.message, 50);
    const detail = (d.contacts && d.contacts.length > 1)
      ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${d.contacts.length} envois enregistrés</div>` : '';
    return `<tr>
      <td><input type="checkbox" class="dup-cb" value="${escAttr(d.phone)}" checked></td>
      <td style="font-family:monospace;font-size:12px">${escHtml(d.phone)}</td>
      <td>${escHtml(d.prenom || '—')} ${escHtml(d.nom || '')}</td>
      <td><span class="badge badge-yellow">${count}×</span></td>
      <td style="max-width:200px;font-size:11px" title="${escAttr(d.lastMessage||'')}">${escHtml(why)}${detail}</td>
      <td style="font-size:11px;color:var(--muted)">${escHtml(sentStr)}</td>
      <td>${escHtml(bot)}</td>
    </tr>`;
  }).join('');
  const pager = document.getElementById('dup-pager');
  if (pages > 1) {
    pager.style.display = 'flex';
    let ph = `<span>${dupListCache.length} doublons · page ${dupPage}/${pages}</span>`;
    if (dupPage > 1) ph += `<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="goDupPage(${dupPage-1})">←</button>`;
    if (dupPage < pages) ph += `<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="goDupPage(${dupPage+1})">→</button>`;
    pager.innerHTML = ph;
  } else {
    pager.style.display = 'none';
    pager.innerHTML = '';
  }
}

function goDupPage(n) {
  dupPage = n;
  renderDupTablePage();
}

function showDuplicatePanel(duplicates) {
  const seen = new Set();
  const unique = [];
  for (const d of duplicates) {
    const p = phoneDigits(d.phone);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    unique.push({ ...d, phone: p });
  }
  pendingImportContext.duplicates = unique;
  dupListCache = unique;
  dupPage = 1;
  renderDupTablePage();
  document.getElementById('dup-select-all').checked = true;
  document.getElementById('dup-confirm-box').style.display = 'block';
  document.getElementById('dup-confirm-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}"""

if OLD_SHOW_DUP not in t:
    raise SystemExit("showDuplicatePanel not found")
t = t.replace(OLD_SHOW_DUP, NEW_SHOW_DUP, 1)

t = t.replace(
    """function dismissDuplicatePanel() {
  document.getElementById('dup-confirm-box').style.display = 'none';
  pendingImportContext = null;
  clearCSVFiles();
}""",
    """function dismissDuplicatePanel() {
  document.getElementById('dup-confirm-box').style.display = 'none';
  document.getElementById('dup-pager').style.display = 'none';
  pendingImportContext = null;
  dupListCache = [];
}""",
    1,
)

# importAllCSV finally
OLD_IMPORT = """  btn.disabled=true; btn.textContent='⏳ Import en cours...';
  let totalAdded=0, totalSkipped=0, errors=[];
  const allDuplicates = [];

  pendingImportContext = { message, link, files: [...pendingCSVFiles], duplicates: [], totalAdded: 0, totalSkipped: 0, errors: [] };

  for (const file of pendingCSVFiles) {
    try {
      const r = await postImportCSV(file, message, link, []);
      if (r.ok) {
        totalAdded += r.added || 0;
        totalSkipped += r.skippedQueue || r.skipped || 0;
        if (r.needsConfirmation && r.duplicates && r.duplicates.length) {
          allDuplicates.push(...r.duplicates);
        }
      } else errors.push(file.name+': '+(r.error||'erreur'));
    } catch(e){ errors.push(file.name+': erreur réseau'); }
  }

  btn.disabled=false; btn.textContent='📤 Importer tous les fichiers';
  pendingImportContext.totalAdded = totalAdded;
  pendingImportContext.totalSkipped = totalSkipped;
  pendingImportContext.errors = errors;

  if (allDuplicates.length) {
    showImportResult(totalAdded, totalSkipped, errors, link, allDuplicates.length);
    showDuplicatePanel(allDuplicates);
    return;
  }

  showImportResult(totalAdded, totalSkipped, errors, link);
  clearCSVFiles();
  pendingImportContext = null;
}"""

NEW_IMPORT = """  btn.disabled=true; btn.textContent='⏳ Import en cours...';
  let totalAdded=0, totalSkipped=0, errors=[];
  const allDuplicates = [];

  pendingImportContext = { message, link, files: [...pendingCSVFiles], duplicates: [], totalAdded: 0, totalSkipped: 0, errors: [] };

  try {
    for (const file of pendingCSVFiles) {
      try {
        const r = await postImportCSV(file, message, link, []);
        if (r.ok) {
          totalAdded += r.added || 0;
          totalSkipped += r.skippedQueue || r.skipped || 0;
          if (r.needsConfirmation && r.duplicates && r.duplicates.length) {
            allDuplicates.push(...r.duplicates);
          }
        } else errors.push(file.name+': '+(r.error||'erreur'));
      } catch(e){ errors.push(file.name+': erreur réseau'); }
    }

    pendingImportContext.totalAdded = totalAdded;
    pendingImportContext.totalSkipped = totalSkipped;
    pendingImportContext.errors = errors;

    if (allDuplicates.length) {
      showImportResult(totalAdded, totalSkipped, errors, link, allDuplicates.length);
      showDuplicatePanel(allDuplicates);
      return;
    }

    showImportResult(totalAdded, totalSkipped, errors, link);
    clearCSVFiles();
    pendingImportContext = null;
  } catch (e) {
    document.getElementById('import-result').innerHTML = `<span class="badge badge-red">Erreur import : ${escHtml(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Importer tous les fichiers';
  }
}"""

if OLD_IMPORT not in t:
    raise SystemExit("importAllCSV block not found")
t = t.replace(OLD_IMPORT, NEW_IMPORT, 1)

# loadQueue limit
t = t.replace(
    "const r = await fetch(`/api/${currentAccount}/queue?limit=500`).then(r=>r.json());",
    "const r = await fetch(`/api/${currentAccount}/queue?limit=5000`).then(r=>r.json());",
    1,
)

# sendTest + hist onclick phones
t = t.replace(
    "onclick=\"toggleHistDetail('${phone}')\"",
    "onclick=\"toggleHistDetail('${escAttr(phone)}')\"",
    1,
)
t = t.replace(
    "onclick=\"deleteHistEntry('${phone}')\"",
    "onclick=\"deleteHistEntry('${escAttr(phone)}')\"",
    1,
)
# fix hist phone display
t = t.replace(
    "      rows += `<tr>\n        <td style=\"font-family:monospace;font-size:12px\">${phone}</td>",
    "      rows += `<tr>\n        <td style=\"font-family:monospace;font-size:12px\">${escHtml(phone)}</td>",
    1,
)

t = t.replace(
    "    : `<span class=\"badge badge-red\">Erreur : ${r.error||'inconnue'}</span>`;",
    "    : `<span class=\"badge badge-red\">Erreur : ${escHtml(r.error||'inconnue')}</span>`;",
    1,
)

P.write_text(t, encoding="utf-8")
print("ok")
