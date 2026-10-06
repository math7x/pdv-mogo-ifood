const KIND_LABELS = { product: 'Produto', addon: 'Adicional', size: 'Tamanho de pizza', flavor: 'Sabor de pizza' };
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');

function showStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

async function updateCount() {
  const { mogoRecords = [] } = await chrome.storage.local.get('mogoRecords');
  const counts = Object.fromEntries(Object.keys(KIND_LABELS).map((kind) => [kind, mogoRecords.filter((r) => r.kind === kind).length]));
  const total = mogoRecords.length;
  countEl.textContent = total
    ? `${total} códigos capturados: ${counts.product} produtos, ${counts.addon} adicionais/bordas, ${counts.size} tamanhos e ${counts.flavor} sabores.`
    : 'Nenhum código capturado ainda.';
}

document.getElementById('capture').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || /^chrome:\/\//.test(tab.url || '') || /^chrome-extension:\/\//.test(tab.url || '')) {
      throw new Error('Abra uma tela da Mogo antes de iniciar a captura.');
    }
    const kind = document.getElementById('kind').value;
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanVisibleCatalog,
      args: [kind]
    });
    const frameData = frameResults.map((frame) => frame.result || { rows: [] });
    const result = frameData.flatMap((data) => data.rows || []);
    const visibleTotal = frameData.reduce((sum, data) => sum + (Number(data.totalVisible) || 0), 0);
    const pagerText = frameData.map((data) => data.pagerText).filter(Boolean).join(' • ');
    if (!result?.length) {
      showStatus('Não encontrei linhas com nome e ID numérico nesta tela. Abra a lista de cadastros da Mogo com os IDs visíveis e tente novamente.', 'err');
      return;
    }
    const { mogoRecords = [] } = await chrome.storage.local.get('mogoRecords');
    const hasGridCapture = frameData.some((data) => data.gridFound);
    // Keep the tab the user explicitly activated on Mogo. This lets the review page
    // return to the correct local address even when the PDV's IP changes.
    await chrome.storage.local.set({ mogoActiveTabId: tab.id, mogoActiveTabUrl: tab.url || '' });
    const existing = hasGridCapture ? mogoRecords.filter((r) => r.kind !== kind) : mogoRecords;
    const seen = new Set(existing.map((r) => `${r.kind}|${r.id}|${r.name.toLocaleLowerCase('pt-BR')}`));
    const added = result.filter((r) => !seen.has(`${r.kind}|${r.id}|${r.name.toLocaleLowerCase('pt-BR')}`));
    const kept = hasGridCapture ? existing : [...existing, ...added];
    const updated = hasGridCapture ? [...kept, ...result] : kept;
    await chrome.storage.local.set({ mogoRecords: updated });
    const coverage = visibleTotal ? ` A grade mostra ${pagerText || `${visibleTotal} linha(s)`}.` : '';
    showStatus(`${result.length} ${KIND_LABELS[kind].toLocaleLowerCase('pt-BR')} capturado(s) nesta tela.${coverage} ${hasGridCapture ? 'Os dados anteriores desta categoria foram substituídos.' : `${result.length - added.length} já estavam guardados.`}`, 'ok');
    await updateCount();
  } catch (error) {
    showStatus(`Não consegui ler esta tela: ${error.message}`, 'err');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('export').addEventListener('click', async () => {
  const { mogoRecords = [] } = await chrome.storage.local.get('mogoRecords');
  if (!mogoRecords.length) {
    showStatus('Ainda não há dados para exportar.', 'err');
    return;
  }
  const payload = { source: 'Mogo', exportedAt: new Date().toISOString(), records: mogoRecords };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'captura-mogo.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus('Arquivo de conferência preparado.', 'ok');
});

document.getElementById('ifood').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https:\/\/portal\.ifood\.com\.br\/menu\/list\/pdv/.test(tab?.url || '')) {
    showStatus('Abra primeiro Cardápio > Integração com PDV no Portal iFood.', 'err');
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('mogoRecords');
  showStatus('Captura apagada.', 'ok');
  await updateCount();
});

function scanVisibleCatalog(kind) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const idPattern = /^\d{1,12}$/;
  const rows = [];
  const grid = document.querySelector('table#grid');
  if (grid) {
    const gridId = grid.id;
    const headerFor = (cell) => {
      const described = cell.getAttribute('aria-describedby') || '';
      const header = document.getElementById(described);
      return clean(header?.innerText || header?.textContent || described.replace(`${gridId}_`, '').replaceAll('_', ' '));
    };
    for (const row of grid.querySelectorAll('tr.jqgrow')) {
      const cells = [...row.querySelectorAll('td[aria-describedby]')];
      const idCell = cells.find((cell) => {
        const desc = cell.getAttribute('aria-describedby') || '';
        return desc === `${gridId}_Id` || /^(?:id|c[oó]digo)$/i.test(headerFor(cell));
      });
      const nameCell = cells.find((cell) => /descri[cç][aã]o|nome|sabor|tamanho/i.test(headerFor(cell)) && cell !== idCell);
      const id = clean(idCell?.innerText || idCell?.textContent);
      const name = clean(nameCell?.innerText || nameCell?.textContent);
      if (idPattern.test(id) && name && !/^(editar|clonar)$/i.test(name)) {
        rows.push({ kind, id, name, sourceUrl: location.href, capturedAt: new Date().toISOString() });
      }
    }
    const pagerText = clean(document.querySelector('#pager_right')?.innerText);
    const parsedTotal = pagerText.match(/(?:-|de)\s*(\d+)\s*$/i);
    const pagerCenter = clean(document.querySelector('#pager_center')?.innerText);
    const pageInfo = pagerCenter.match(/P[aá]gina\s*(\d+)\s*de\s*(\d+)/i);
    return {
      rows: [...new Map(rows.map((r) => [`${r.id}|${r.name.toLocaleLowerCase('pt-BR')}`, r])).values()],
      totalVisible: rows.length,
      pagerText: pageInfo ? `${pagerText} (página ${pageInfo[1]} de ${pageInfo[2]})` : pagerText,
      gridFound: true
    };
  }
  const addRow = (cells, element) => {
    if (!visible(element)) return;
    const values = cells.map(clean).filter(Boolean);
    const id = values.find((value) => idPattern.test(value)) ||
      clean(element.getAttribute('data-id') || element.getAttribute('data-code') || element.getAttribute('data-key'));
    if (!idPattern.test(id)) return;
    const name = values.find((value) => value !== id && !idPattern.test(value) && value.length > 1);
    if (!name) return;
    rows.push({ kind, id, name, sourceUrl: location.href, capturedAt: new Date().toISOString() });
  };
  for (const row of document.querySelectorAll('tr,[role="row"],li,[class*="product"],[class*="Produto"],[class*="item-row"]')) {
    if (!visible(row)) continue;
    const cells = [...row.querySelectorAll('th,td,[role="cell"],[role="gridcell"],span,a,p,div')]
      .filter((el) => el.children.length === 0 || el.matches('td,th,[role="cell"],[role="gridcell"]'))
      .map((el) => el.innerText || el.textContent);
    addRow(cells, row);
  }
  const unique = new Map();
  for (const row of rows) unique.set(`${row.id}|${row.name.toLocaleLowerCase('pt-BR')}`, row);
  return { rows: [...unique.values()], totalVisible: unique.size, pagerText: '', gridFound: false };
}

updateCount();
