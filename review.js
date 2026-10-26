const statusEl = document.getElementById('rv-final-summary');
const resultsEl = document.getElementById('rv-main');
const summaryEl = document.getElementById('rv-summary-bar');
const applyButton = document.getElementById('rv-btn-apply');
const emptyEl = document.getElementById('rv-empty');
let currentPlan = [];
let activeTab = 'option';
let allMogoRecords = [];
let mogoActiveTabUrl = '';
let reviewProvider = 'ifood';
let targetTabId = null;

const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim();
function similarity(a, b) {
  const aa = normalize(a).split(' ').filter((w) => w.length > 1);
  const bb = normalize(b).split(' ').filter((w) => w.length > 1);
  if (!aa.length || !bb.length) return 0;
  const set = new Set(bb);
  const common = aa.filter((w) => set.has(w)).length;
  return common / Math.max(new Set(aa).size, set.size);
}
function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'block' : 'none';
  statusEl.className = kind === 'rv-message-error' ? 'rv-error' : kind === 'rv-message-ok' ? 'rv-success' : '';
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function typeLabel(kind) { return ({product:'Produto',addon:'Adicional/borda',size:'Tamanho de pizza',flavor:'Sabor de pizza'})[kind] || 'Opção'; }
function makeCode(kind, id) { return reviewProvider === 'multipedidos' ? String(id) : kind === 'product' ? String(id) : ({ addon: `AD${id}`, size: `PZ${id}`, flavor: `S${id}` }[kind] || String(id)); }
function upgradeSavedPlan(plan) {
  return plan.map((item) => {
    item.options = (item.options || []).slice(0, 12);
    const best = item.options[0];
    item.code ||= best ? makeCode(item.kind, best.id) : '';
    const next = item.options[1];
    item.selectedMogoId ||= best ? String(best.id) : '';
    if (!item.status) {
      item.status = item.code && item.code.toLocaleLowerCase('pt-BR') === String(item.currentCode || '').trim().toLocaleLowerCase('pt-BR')
        ? 'correct'
        : best && best.score >= 0.999 && (!next || best.score - next.score >= 0.12) ? 'exact'
          : best && next && best.score - next.score < 0.06 ? 'ambiguous'
            : best && best.score >= 0.30 ? 'approximate' : 'unmatched';
    }
    if (item.status !== 'exact' && item.status !== 'manual') item.selected = false;
    return item;
  });
}

async function getIfoodTab() {
  const tabs = await chrome.tabs.query({ url: 'https://portal.ifood.com.br/menu/list/pdv*' });
  return tabs.find((t) => t.active) || tabs[0];
}
async function getTargetTab() {
  if (reviewProvider === 'multipedidos') {
    if (targetTabId) {
      try {
        const tab = await chrome.tabs.get(targetTabId);
        if (/^https:\/\/app\.multipedidos\.com\.br\//.test(tab.url || '')) return tab;
      } catch {}
    }
    const tabs = await chrome.tabs.query({ url: 'https://app.multipedidos.com.br/*' });
    return tabs.find((tab) => tab.active) || tabs[0];
  }
  return getIfoodTab();
}
async function savePlan() { await chrome.storage.local.set({ mogoReviewPlan: currentPlan, mogoReviewPlanProvider: reviewProvider }); }

document.getElementById('scan').addEventListener('click', async () => {
  const button = document.getElementById('scan'); button.disabled = true;
  setStatus(reviewProvider === 'multipedidos' ? 'Lendo produtos e complementos do Multipedidos...' : 'Lendo os itens e opções do iFood...');
  try {
    const { mogoRecords = [] } = await chrome.storage.local.get('mogoRecords');
    if (!mogoRecords.length) throw new Error('Capture primeiro os cadastros da Mogo.');
    allMogoRecords = mogoRecords;
    const tab = await getTargetTab();
    if (!tab?.id) throw new Error(reviewProvider === 'multipedidos' ? 'Não encontrei a aba do Multipedidos. Abra o Editor de Produtos ou Cardápio e tente novamente.' : 'Não encontrei o Portal iFood aberto na tela Cardápio > Integração com PDV.');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: reviewProvider === 'multipedidos' ? scanMultipedidosPage : scanIfoodPage });
    const targets = result || [];
    if (!targets.length) throw new Error(reviewProvider === 'multipedidos' ? 'Não encontrei produtos ou opções visíveis. Abra o Editor de Produtos ou a tela de complementos e tente novamente.' : 'Não encontrei campos de código PDV. Confira se o cardápio terminou de carregar.');
    const alreadyLinked = reviewProvider === 'multipedidos' ? targets.filter((target) => String(target.currentCode || '').trim()) : [];
    const pendingTargets = reviewProvider === 'multipedidos' ? targets.filter((target) => !String(target.currentCode || '').trim()) : targets;
    currentPlan = pendingTargets.map((target) => {
      const options = mogoRecords
        .filter((r) => reviewProvider === 'multipedidos' ? (target.kind === 'product' ? r.kind === 'product' : r.kind !== 'product') : r.kind === target.kind)
        .map((r) => ({ kind:r.kind, id:r.id, name:r.name, score:similarity(target.name, r.name) }))
        .sort((a,b) => b.score-a.score)
        .slice(0,12);
      const best = options[0];
      const next = options[1];
      const exact = best && best.score >= 0.999 && (!next || best.score - next.score >= 0.12);
      const code = best ? makeCode(target.kind, best.id) : '';
      const status = code && code.toLocaleLowerCase('pt-BR') === String(target.currentCode || '').trim().toLocaleLowerCase('pt-BR')
        ? 'correct'
        : exact ? 'exact'
          : best && next && best.score - next.score < 0.06 ? 'ambiguous'
            : best && best.score >= 0.30 ? 'approximate' : 'unmatched';
      return { ...target, options, code, status, selected: status === 'exact' && code !== target.currentCode, score: best?.score || 0 };
    });
    await savePlan();
    render();
    if (reviewProvider === 'multipedidos' && !pendingTargets.length && alreadyLinked.length) {
      emptyEl.textContent = 'Nenhum item pendente: todos os códigos encontrados nesta leitura já estão preenchidos.';
    }
    const selected = currentPlan.filter((r) => r.selected).length;
    const skippedLinked = alreadyLinked.length ? ` ${alreadyLinked.length} item(ns) com Código Externo já preenchido(s) foram ocultados.` : '';
    setStatus(`${pendingTargets.length} ${reviewProvider === 'multipedidos' ? 'produto(s) e complemento(s) pendente(s) lido(s)' : 'campos lidos'}.${skippedLinked} ${selected} correspondência(s) exata(s) pré-selecionada(s); confira antes de aplicar.`, 'rv-message-ok');
  } catch (error) { setStatus(error.message, 'rv-message-error'); }
  finally { button.disabled = false; }
});

document.getElementById('refresh').addEventListener('click', async () => {
  const { mogoRecords = [] } = await chrome.storage.local.get('mogoRecords');
  allMogoRecords = mogoRecords;
  renderMain();
  setStatus(`${mogoRecords.length} código(s) Mogo guardados. Releia o iFood para atualizar as sugestões.`, 'rv-message-ok');
});

document.getElementById('rv-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.rv-tab-btn');
  if (!tab) return;
  activeTab = tab.dataset.tab;
  document.querySelectorAll('.rv-tab-btn').forEach((el) => el.classList.toggle('is-active', el === tab));
  renderMain();
});

resultsEl.addEventListener('change', async (event) => {
  const row = event.target.closest('tr[data-index]');
  if (!row) return;
  const item = currentPlan[Number(row.dataset.index)];
  if (event.target.matches('.rv-check')) item.selected = event.target.checked;
  if (event.target.matches('.rv-parent-search')) {
    const source = allMogoRecords.find((record) => record.kind === 'product' && productChoiceLabel(record) === event.target.value);
    if (source) {
      item.selectedMogoId = String(source.id);
      item.code = String(source.id);
      item.score = similarity(item.name, source.name);
      item.status = item.score >= 0.999 ? 'manual' : 'manual';
      item.selected = item.code !== String(item.currentCode || '').trim();
      const checkbox = row.querySelector('.rv-check');
      if (checkbox) checkbox.checked = item.selected;
      const codeInput = row.querySelector('.rv-search');
      if (codeInput) codeInput.value = item.code;
      const sourceName = row.querySelector('.rv-source-name');
      if (sourceName) sourceName.textContent = `${source.name} · ${source.id}`;
    } else {
      item.selectedMogoId = '';
      item.code = '';
      item.selected = false;
    }
  }
  if (event.target.matches('.rv-alt-select')) {
    const source = event.target.value === '' ? null : item.options[Number(event.target.value)];
    item.code = source ? makeCode(item.kind, source.id) : '';
    item.status = source && source.score >= 0.999 ? 'exact' : source ? 'manual' : 'unmatched';
    const input = row.querySelector('.rv-search');
    if (input) input.value = item.code;
    item.selected = Boolean(source && item.code !== String(item.currentCode || '').trim());
  }
  if (event.target.matches('.rv-create-type')) {
    item.createTaxType = event.target.value;
    await savePlan();
  }
  updateSummary();
  await savePlan();
  if (event.target.matches('.rv-parent-search, .rv-alt-select')) renderMain();
});
resultsEl.addEventListener('click', async (event) => {
  const button = event.target.closest('.rv-btn-create-mogo');
  if (!button) return;
  const row = button.closest('tr[data-index]');
  const item = currentPlan[Number(row?.dataset.index)];
  if (!item) return;
  const taxType = row.querySelector('.rv-create-type')?.value || 'food';
  const typeLabel = taxType === 'beverage' ? 'bebida' : 'comida';
  if (!confirm(`Abrir na Mogo o cadastro de "${item.name}" com preço 0,00 e tributação padrão de ${typeLabel}? O formulário ficará aberto para você conferir e salvar.`)) return;

  let permissionPromise;
  try {
    const originPattern = `${new URL(mogoActiveTabUrl).origin}/*`;
    permissionPromise = chrome.permissions.request({ origins: [originPattern] });
  } catch (error) {
    setStatus(`Não consegui solicitar acesso ao endereço da Mogo: ${error.message}`, 'rv-message-error');
    return;
  }
  button.disabled = true;
  setStatus('Abrindo o cadastro na aba da Mogo…');
  try {
    const allowed = await permissionPromise;
    if (!allowed) throw new Error('Acesso ao endereço da Mogo não foi autorizado. Clique novamente em Criar na Mogo e permita o acesso solicitado pelo navegador.');
    const { mogoActiveTabId } = await chrome.storage.local.get('mogoActiveTabId');
    if (!mogoActiveTabId) throw new Error('Ative a captura em uma tela da Mogo e leia Produtos uma vez para registrar essa aba.');
    const tab = await chrome.tabs.get(mogoActiveTabId);
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('A aba Mogo registrada não está disponível. Abra a Mogo, ative a extensão e capture Produtos novamente.');
    await chrome.tabs.update(tab.id, { active: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: prepareMogoProductForm,
      args: [{ name: item.name, taxType }]
    });
    if (!result?.ok) throw new Error(result?.message || 'A Mogo não confirmou o preenchimento do formulário.');
    setStatus(`Cadastro preparado na Mogo: ${item.name}. ${result.message} Depois capture Produtos novamente para vincular o ID.`, 'rv-message-ok');
  } catch (error) {
    setStatus(`Não consegui preparar o cadastro na Mogo: ${error.message}`, 'rv-message-error');
  } finally { button.disabled = false; }
});
resultsEl.addEventListener('input', async (event) => {
  if (!event.target.matches('.rv-search')) return;
  const row = event.target.closest('tr[data-index]');
  if (!row) return;
  const item = currentPlan[Number(row.dataset.index)];
  item.code = event.target.value.trim();
  if (item.status === 'correct' && item.code !== item.currentCode) item.status = 'manual';
  updateSummary();
  await savePlan();
});

function stat(value, label) { return `<div class="rv-stat"><strong>${value}</strong><span>${label}</span></div>`; }
function updateSummary() {
  const count = (fn) => currentPlan.filter(fn).length;
  const selectedCount = count((r) => r.selected && r.code);
  summaryEl.innerHTML = [
    stat(count((r) => r.status === 'correct' || r.status === 'applied'), 'já corretos'),
    stat(count((r) => r.selected && r.code), 'selecionados'),
    stat(count((r) => r.status === 'exact' || r.status === 'manual'), 'prontos para aplicar'),
    stat(count((r) => r.status === 'approximate'), 'para revisar'),
    stat(count((r) => ['ambiguous','unmatched'].includes(r.status)), 'sem correspondência segura')
  ].join('');
  const canApply = currentPlan.some((r) => r.selected && r.code.trim() && r.code.trim() !== String(r.currentCode || '').trim());
  applyButton.disabled = !canApply;
  applyButton.textContent = selectedCount ? `⚠️ Aplicar selecionados (${selectedCount})` : '⚠️ Aplicar selecionados';
}

function render() { updateSummary(); renderTabs(); renderMain(); }
function renderTabs() {
  const counts = {
    product: currentPlan.filter((r) => r.kind === 'product').length,
    option: currentPlan.filter((r) => r.kind !== 'product').length
  };
  document.querySelectorAll('.rv-tab-btn').forEach((button) => {
    const label = {product:'Produtos pai 🍕',option:'Complementos'}[button.dataset.tab];
    button.innerHTML = `${label}<span class="rv-tab-count">${counts[button.dataset.tab]}</span>`;
  });
}
function statusLabel(status) {
  return ({correct:'Já correto',exact:'Nome exato',approximate:'Confira o nome',ambiguous:'Mais de uma opção',unmatched:'Sem sugestão segura',manual:'Escolhido por você',applied:'Preenchido'})[status] || status;
}
function productChoiceLabel(record) { return `${record.name} — ${record.id}`; }
function rowHtml(item) {
  const options = item.options.map((o, i) => `<option value="${i}" ${i===0?'selected':''}>${escapeHtml(o.name)} — ${escapeHtml(makeCode(item.kind,o.id))} (${Math.round(o.score*100)}%)</option>`).join('');
  const suggested = item.options[0];
  const parentRecord = item.kind === 'product' ? allMogoRecords.find((r) => String(r.id) === String(item.selectedMogoId || suggested?.id) && r.kind === 'product') : null;
  const selectedSource = item.kind === 'product' ? parentRecord : suggested;
  const source = selectedSource ? `${escapeHtml(selectedSource.name)} · ${escapeHtml(makeCode(item.kind,selectedSource.id))}` : 'Nenhum cadastro deste tipo foi capturado';
  const group = item.parentName || item.groupName;
  const editable = item.status !== 'correct' && item.status !== 'applied';
  const parentChoice = item.kind === 'product' && editable
    ? `<input type="search" class="rv-alt-search rv-parent-search" list="rv-mogo-products" value="${escapeHtml(parentRecord ? productChoiceLabel(parentRecord) : '')}" placeholder="Pesquisar produto pai ou ID..." autocomplete="off">`
    : editable && item.options.length > 1 ? `<select class="rv-alt-select"><option value="">Escolher outra opção...</option>${options}</select>` : '';
  const canCreateMogoProduct = item.kind === 'product'
    && !String(item.currentCode || '').trim()
    && ['unmatched', 'approximate', 'ambiguous'].includes(item.status);
  const createAction = canCreateMogoProduct
    ? `<div class="rv-create-mogo-wrap"><select class="rv-create-type" aria-label="Tipo fiscal"><option value="food" ${item.createTaxType !== 'beverage' ? 'selected' : ''}>Comida</option><option value="beverage" ${item.createTaxType === 'beverage' ? 'selected' : ''}>Bebida</option></select><button type="button" class="rv-btn-create-mogo">Criar na Mogo</button></div>`
    : '';
  return `<tr data-index="${item._index}" class="${item.status==='correct'?'rv-row-correct':''}">
    <td><input class="rv-check" type="checkbox" ${item.selected?'checked':''} ${editable?'':'disabled'} aria-label="Aplicar código"></td>
    <td><span class="rv-type-badge">${typeLabel(item.kind)}</span></td>
    <td class="rv-item-name"><strong>${escapeHtml(item.name)}</strong>${group?`<div class="rv-parent-code">${escapeHtml(group)}</div>`:''}</td>
    <td class="rv-item-name rv-source-cell"><span class="rv-source-name">${source}</span>${parentChoice}${createAction}</td>
    <td><span class="rv-current-code">${escapeHtml(item.currentCode || '(vazio)')}</span></td>
    <td class="rv-new-code">${editable?`<input class="rv-search" type="text" value="${escapeHtml(item.code)}" placeholder="Código Mogo sugerido">`:escapeHtml(item.code || item.currentCode)}</td>
    <td><span class="rv-status ${item.status==='correct'?'rv-ok':item.status==='exact'?'rv-ok':item.status==='approximate'||item.status==='ambiguous'?'rv-warn':'rv-fail'}">${statusLabel(item.status)}</span><div class="rv-parent-code">${Math.round(item.score*100)}% de semelhança</div></td>
  </tr>`;
}
function renderMain() {
  if (!currentPlan.length) { emptyEl.style.display='block'; return; }
  const makePanel = (type) => {
    const rows = currentPlan.map((r,i)=>({...r,_index:i})).filter((r)=>type==='product' ? r.kind==='product' : r.kind!=='product');
    const sections = [
      {keys:['correct','applied'],title:'Já corretos',className:'rv-sec-correto',open:false,hint:'O código atual já corresponde ao ID capturado na Mogo.'},
      {keys:['exact','manual'],title:'Prontos para aplicar — alta confiança',className:'rv-sec-alta',open:true,hint:'Confira os códigos sugeridos. As correspondências exatas já vêm marcadas.'},
      {keys:['approximate'],title:'Para revisar — confiança média',className:'rv-sec-media',open:true,hint:'Confira o nome, pesquise outro cadastro ou ajuste o código antes de marcar.'},
      {keys:['ambiguous','unmatched'],title:'Score baixo / sem correspondência segura',className:'rv-sec-baixa',open:true,hint:'Use a busca para localizar o produto pai na Mogo ou confira o código manualmente.'}
    ];
    return sections.map((section) => {
      const matches=rows.filter((r)=>section.keys.includes(r.status));
      if(!matches.length) return '';
      const itemHeading = reviewProvider === 'multipedidos' ? 'Item no Multipedidos' : 'Item no iFood';
      const codeHeading = reviewProvider === 'multipedidos' ? 'Novo Código Externo' : 'Novo código PDV';
      const table=`<div class="rv-table-scroll"><table class="rv-table"><thead><tr><th>Aplicar</th><th>Tipo</th><th>${itemHeading}</th><th>Correspondência na Mogo</th><th>Código atual</th><th>${codeHeading}</th><th>Resultado</th></tr></thead><tbody>${matches.map(rowHtml).join('')}</tbody></table></div>`;
      return `<details class="rv-section ${section.className}" ${section.open?'open':''}><summary><span>${section.title}</span><span class="rv-count-badge">${matches.length}</span></summary><div class="rv-section-body"><p class="rv-section-hint">${section.hint}</p>${table}</div></details>`;
    }).join('');
  };
  const productChoices=allMogoRecords.filter((r)=>r.kind==='product').map((r)=>`<option value="${escapeHtml(productChoiceLabel(r))}"></option>`).join('');
  const productPanel=`<datalist id="rv-mogo-products">${productChoices}</datalist>${makePanel('product')}`;
  const optionPanel=makePanel('option');
  emptyEl.style.display='none';
  resultsEl.querySelectorAll('.rv-tab-panel').forEach((node)=>node.remove());
  resultsEl.insertAdjacentHTML('beforeend',`<div class="rv-tab-panel" data-tab="option" ${activeTab==='option'?'':'hidden'}>${optionPanel}</div><div class="rv-tab-panel" data-tab="product" ${activeTab==='product'?'':'hidden'}>${productPanel}</div>`);
}

applyButton.addEventListener('click', () => apply(currentPlan));
async function apply(plan) {
  const changes = plan.filter((r) => r.selected && r.code.trim() && r.code.trim() !== String(r.currentCode || '').trim()).map((r) => ({ ...r, code: r.code.trim() }));
  if (!changes.length) { setStatus('Marque pelo menos uma linha e confira o código.', 'rv-message-error'); return; }
  const destination = reviewProvider === 'multipedidos' ? 'Multipedidos' : 'iFood';
  if (!confirm(`Preencher ${changes.length} código(s) no ${destination}? Confira se esta é a loja correta.`)) return;
  applyButton.disabled = true;
  setStatus(`Preenchendo ${changes.length} código(s) no ${destination}...`);
  try {
    const tab = await getTargetTab();
    if (!tab?.id) throw new Error(`A aba do ${destination} foi fechada.`);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: reviewProvider === 'multipedidos' ? applyMultipedidosCodes : applyIfoodCodes, args: [changes] });
    const appliedKeys = Array.isArray(result.appliedItems) ? new Set(result.appliedItems.map((r) => `${r.kind}|${r.itemid}|${r.optionid || ''}`)) : null;
    for (const item of changes) {
      if (appliedKeys && !appliedKeys.has(`${item.kind}|${item.itemid}|${item.optionid || ''}`)) continue;
      const stored = currentPlan.find((r) => r.itemid===item.itemid && r.optionid===item.optionid && r.kind===item.kind);
      if (stored) { stored.currentCode=item.code; stored.selected=false; stored.status='applied'; }
    }
    await savePlan(); render();
    const failureDetails = Array.isArray(result.failures) && result.failures.length ? ` Motivos: ${result.failures.slice(0, 3).join(' • ')}${result.failures.length > 3 ? ' • …' : ''}` : '';
    setStatus(`${result.applied} código(s) preenchido(s). ${result.missing ? `${result.missing} campo(s) não foram encontrados.${failureDetails}` : `Confira o resultado na página do ${destination}.`}`, result.missing ? 'rv-message-error' : 'rv-message-ok');
  } catch (error) { setStatus(`Falha ao preencher: ${error.message}`, 'rv-message-error'); }
  finally { applyButton.disabled = !currentPlan.some((r)=>r.selected && r.code); }
}

// Opens the Mogo "Produto de venda" form and prepares a zero-price record.
// It intentionally leaves the final save to the user for review.
async function prepareMogoProductForm({ name, taxType }) {
  const visible = (el) => {
    if (!el?.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (test, attempts = 30) => {
    for (let i = 0; i < attempts; i++) {
      const value = test();
      if (value) return value;
      await wait(120);
    }
    return null;
  };
  const clean = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
  const setInput = (input, value) => {
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  };
  const setSelect = (id, matcher) => {
    const select = document.getElementById(id) || document.querySelector(`select[name="${id}"]`);
    if (!select) return false;
    const option = [...select.options].find((entry) => matcher(clean(entry.textContent)));
    if (!option) return false;
    select.value = option.value;
    if (window.jQuery) window.jQuery(select).val(option.value).trigger('change');
    else select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const clickText = (value) => {
    const target = [...document.querySelectorAll('body *')]
      .filter((el) => visible(el) && clean(el.textContent) === clean(value))
      .sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height))[0];
    target?.click();
    return Boolean(target);
  };

  let description = document.querySelector('#DescricaoProduto');
  if (!visible(description)) {
    // On the Mogo products grid, the green plus icon is the first toolbar action.
    const matching = [...document.querySelectorAll('a,button,[onclick],input[type="image"],img,[role="button"]')]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), hint: clean(`${el.id} ${el.title} ${el.getAttribute('aria-label')} ${el.getAttribute('src')} ${el.className || ''}`) }))
      .filter(({ rect, hint }) => rect.left < 145 && rect.top > 35 && rect.top < 125 && /(novo|inser|adicion|add|plus|mais)/.test(hint))
      .sort((a, b) => a.rect.left - b.rect.left);
    if (matching[0]) matching[0].el.click();
    else {
      const x = Math.min(84, window.innerWidth - 1), y = Math.min(82, window.innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      if (!hit) return { ok: false, message: 'Abra Cadastros > Produtos na Mogo antes de tentar novamente.' };
      hit.click();
    }
    const saleChoice = await waitFor(() => [...document.querySelectorAll('body *')].some((el) => visible(el) && clean(el.textContent) === 'venda'));
    if (saleChoice) {
      clickText('Venda');
      description = await waitFor(() => {
        const field = document.querySelector('#DescricaoProduto');
        return visible(field) ? field : null;
      });
    }
  }
  if (!visible(description)) return { ok: false, message: 'Não localizei o formulário de produto. Abra Cadastros > Produtos e tente novamente.' };

  const price = document.querySelector('#Preco');
  const missing = [];
  if (!setInput(description, name)) missing.push('Descrição');
  if (!setInput(price, '0')) missing.push('Preço zero');
  if (!setSelect('Grupo_Id', (text) => text === 'ifood')) missing.push('Subgrupo IFOOD');

  const fiscalTab = [...document.querySelectorAll('a,[role="tab"]')].find((el) => clean(el.textContent) === 'fiscal');
  fiscalTab?.click();
  await waitFor(() => document.getElementById('ICMS_Id') || document.getElementById('ImpostoIBPT_Id'));
  const cfop = taxType === 'beverage' ? '5405-500' : '5102-102';
  if (!setSelect('ICMS_Id', (text) => text.includes(clean(cfop)))) missing.push(`CFOP ${cfop}`);
  if (!setSelect('ImpostoIBPT_Id', (text) => text.includes('21069090'))) missing.push('NCM 21069090');
  if (!setSelect('PIS_Id', (text) => text.includes('99') && text.includes('outras operacoes'))) missing.push('PIS 99');
  if (!setSelect('Cofins_Id', (text) => text.includes('99') && text.includes('outras operacoes'))) missing.push('Cofins 99');
  if (missing.length) return { ok: false, message: `Não salvei porque não consegui preencher: ${missing.join(', ')}. Confira o formulário aberto.` };

  const controls = [...document.querySelectorAll('button,a,[onclick],[role="button"],input[type="image"],input[type="submit"]')].filter(visible);
  const saveControl = controls.find((el) => /salv|save|gravar/i.test([
    el.textContent, el.id, el.className, el.title, el.getAttribute('aria-label'),
    el.getAttribute('src'), el.getAttribute('onclick'), el.getAttribute('data-original-title')
  ].join(' '))) || document.querySelector('form button[type="submit"],form input[type="submit"]');
  let clickableSave = saveControl;
  if (!clickableSave || !visible(clickableSave)) {
    // The Mogo form uses a blue floppy-disk icon as the first toolbar action.
    const firstToolbarIcon = [...document.images]
      .filter((img) => visible(img))
      .map((img) => ({ img, rect: img.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left >= 35 && rect.left < 180 && rect.top >= 20 && rect.top < 150)
      .sort((a, b) => a.rect.left - b.rect.left)[0]?.img;
    clickableSave = firstToolbarIcon?.closest('a,button,[onclick],[role="button"]') || firstToolbarIcon;
  }
  if (!clickableSave || !visible(clickableSave)) return { ok: false, message: 'Preenchi os campos, mas não localizei o botão Salvar. O formulário continua aberto para salvar manualmente.' };
  clickableSave.click();
  await wait(900);
  return { ok: true, message: 'Cadastro enviado para salvar na Mogo. Confira a confirmação na tela.' };
}

chrome.storage.local.get(['mogoReviewPlan','mogoReviewPlanProvider','mogoRecords','mogoActiveTabUrl','mogoReviewProvider','mogoTargetTabId']).then(({ mogoReviewPlan, mogoReviewPlanProvider, mogoRecords, mogoActiveTabUrl: savedMogoUrl, mogoReviewProvider: savedProvider, mogoTargetTabId: savedTargetTabId }) => {
  allMogoRecords = mogoRecords || [];
  mogoActiveTabUrl = savedMogoUrl || '';
  reviewProvider = savedProvider === 'multipedidos' ? 'multipedidos' : 'ifood';
  targetTabId = savedTargetTabId || null;
  document.querySelector('#rv-header h1').textContent = reviewProvider === 'multipedidos' ? 'PDV Mogo → Multipedidos — Revisão' : 'PDV Mogo → iFood — Revisão';
  document.getElementById('rv-meta').textContent = reviewProvider === 'multipedidos' ? 'Compare os nomes e preencha o Código Externo dos produtos e complementos.' : 'Capture os cadastros na Mogo e leia o cardápio do iFood.';
  document.getElementById('scan').textContent = reviewProvider === 'multipedidos' ? 'Ler Multipedidos' : 'Ler cardápio do iFood';
  document.getElementById('rv-btn-apply').textContent = reviewProvider === 'multipedidos' ? '⚠️ Aplicar no Multipedidos' : '⚠️ Aplicar selecionados';
  document.querySelector('#rv-apply-wrap .rv-apply-hint').textContent = reviewProvider === 'multipedidos' ? 'preenche e salva no cardápio do Multipedidos' : 'preenche e salva no cardápio do iFood';
  emptyEl.textContent = reviewProvider === 'multipedidos' ? 'Nenhuma análise disponível. Clique em “Ler Multipedidos”.' : 'Nenhuma análise disponível. Clique em “Ler cardápio do iFood”.';
  if (reviewProvider === 'multipedidos') {
    // Never render the previous Multipedidos plan in a newly opened review
    // tab. Start clean and show only rows from this tab's fresh full scan.
    currentPlan = [];
    render();
    emptyEl.textContent = 'Lendo o catálogo atual do Multipedidos…';
    setStatus('Lendo todos os produtos e complementos do Multipedidos…');
  } else if (mogoReviewPlanProvider === reviewProvider && Array.isArray(mogoReviewPlan) && mogoReviewPlan.length) {
    currentPlan = upgradeSavedPlan(mogoReviewPlan);
    render();
    setStatus('Revisão anterior carregada. Leia novamente se você alterou o cardápio.', 'rv-message-ok');
  }
  // Each newly opened Multipedidos review tab gets a fresh full read. Keep the
  // saved plan visible until the read succeeds, so a temporary tab/load issue
  // does not discard the user's previous review.
  if (reviewProvider === 'multipedidos') document.getElementById('scan').click();
});

async function scanMultipedidosPage() {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalizeName = (value) => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim();
  const isUiLabel = (value) => {
    const text = normalizeName(value);
    return /^(?:novo|nenhum) (?:item|complemento)(?: \d+ (?:itens?|complementos?))?$/.test(text)
      || /^sem complementos?$/.test(text)
      || /^\d+ (?:itens?|complementos?)$/.test(text)
      || /^(?:editar|clonar|excluir|remover|disponivel|preco|mesa)$/.test(text);
  };
  const visible = (el) => {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const found = new Map();
  const productCardKeys = new Set();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Multipedidos renders these dialogs locally; poll more often and use a
  // shorter timeout so a full catalog does not spend seconds per product.
  const waitFor = async (test, attempts = 24) => { for (let i = 0; i < attempts; i++) { const value = test(); if (value) return value; await wait(40); } return null; };
  const editorWasAlreadyOpen = [...document.querySelectorAll('.ngdialog,[role="dialog"],[role="alertdialog"]')]
    .some((el) => visible(el) && /editar produto|adicionar complementos e varia[cç][oõ]es/i.test(clean(el.innerText)));
  const add = (kind, name, card, groupName = '', codeOverride) => {
    name = clean(name);
    if (!name || name.length < 2 || isUiLabel(name)) return;
    const norm = normalizeName(name);
    const currentCode = clean(codeOverride ?? (card?.querySelector('input[ng-model*="externalID"],input[name*="external"],input[id*="external"]')?.value || ''));
    const itemid = card?.getAttribute('data-id') || card?.getAttribute('data-product-id') || card?.id || norm;
    const key = `${kind}:${norm}:${groupName}`;
    if (!found.has(key)) found.set(key, { kind, name, currentCode, itemid, optionid: kind === 'product' ? '' : norm, groupName, parentName: groupName, multiNameKey: norm });
    return found.get(key);
  };
  const nameFrom = (card) => {
    const candidate = card.querySelector('.item-parent-name,.item-child-name,[class*="product-name"],[class*="item-name"],[class*="option-name"],[class*="item-card__name"],h1,h2,h3,h4,[class*="title"]');
    const candidateName = clean(candidate?.textContent);
    if (candidateName && !isUiLabel(candidateName)) return candidateName;
    return clean(card.innerText).split('\n').map(clean).find((line) => line && !/^R\$/.test(line) && !isUiLabel(line)) || '';
  };
  const isProductRow = (el) => {
    if (!visible(el) || el.matches('category-card,[data-cy="categoryCard"],.category-card,[class*="category-card"]')) return false;
    const text = clean(el.innerText);
    // Category headers contain these actions and counters (for example,
    // “Novo item · 2 itens” or “Novo item · Nenhum item”). Product rows do not.
    return !/Novo item|Nenhum item/i.test(text);
  };
  const expandCategories = async () => {
    const categories = [...document.querySelectorAll('category-card,[data-cy="categoryCard"],.category-card,[class*="category-card"]')]
      .filter((el) => visible(el) && !el.parentElement?.closest('category-card,[data-cy="categoryCard"],.category-card,[class*="category-card"]'));
    for (const category of categories) {
      const hasProducts = [...category.querySelectorAll('[data-cy="productCard"],product-card,.product-card,[class*="product-card"]')].some(visible);
      if (hasProducts) continue;
      let toggle = category.querySelector('.show-children,[aria-expanded="false"],[ng-click*="expand" i],[ng-click*="collapse" i],[ng-click*="showProducts" i],[ng-click*="toggleProducts" i],[ng-click*="openCategory" i]');
      if (!toggle) {
        const header = category.querySelector('.category-card__header,[class*="category-header"],[class*="category-card__title"]');
        if (header) toggle = header;
      }
      if (!toggle) {
        toggle = [...category.querySelectorAll('button,[role="button"],svg,i,span,[class*="chevron"],[class*="arrow"],[class*="expand"]')]
          .find((el) => visible(el) && /(?:expand_more|keyboard_arrow_down|chevron|arrow|expand|collapse)/i.test(`${el.className || ''} ${el.getAttribute?.('aria-label') || ''} ${el.textContent || ''}`));
      }
      if (toggle && visible(toggle)) { toggle.click(); await wait(35); }
    }
  };
  const collectCards = () => {
    const productCards = [...document.querySelectorAll('.item-card,[class*="item-card"],.product-card,[class*="product-card"],[data-cy*="product-card"]')]
      .filter((el) => isProductRow(el) && !el.closest('.ngdialog,[role="dialog"]'));
    for (const card of productCards) {
      const record = add('product', nameFrom(card), card);
      if (record) productCardKeys.add(`product:${normalizeName(record.name)}:`);
    }
    const complementDialogs = [...document.querySelectorAll('.ngdialog,[role="dialog"]')].filter((el) => visible(el) && /adicionar complementos e varia[cç][oõ]es/i.test(clean(el.innerText)));
    for (const dialog of complementDialogs) {
      const optionRows = [...dialog.querySelectorAll('.item-card,[class*="item-card"],.extra-option-card,[class*="extra-option-card"],[class*="extra-option__card"],[class*="option-card"]')]
        .filter((el) => visible(el) && !el.parentElement?.closest('.item-card,[class*="item-card"],.extra-option-card,[class*="extra-option-card"],[class*="extra-option__card"],[class*="option-card"]'));
      for (const card of optionRows) add('addon', nameFrom(card), card, 'Complementos');
    }
    const optionCards = [...document.querySelectorAll('.extra-option-card,[class*="extra-option-card"],[class*="extra-option__card"],[class*="option-card"],[data-cy*="extra-option"]')]
      .filter((el) => visible(el) && !el.parentElement?.closest('.extra-option-card,[class*="extra-option-card"],[class*="extra-option__card"],[class*="option-card"]'));
    for (const card of optionCards) {
      const group = clean(card.closest('[class*="extra-group"],[class*="complement-group"]')?.querySelector('[class*="title"],h2,h3')?.textContent || 'Complemento');
      add('addon', nameFrom(card), card, group);
    }
  };
  await expandCategories();
  let previousHeight=-1, stable=0;
  for (let i=0; i<50; i++) {
    collectCards();
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    await wait(90);
    const height = document.body.scrollHeight;
    const bottom = window.innerHeight + window.scrollY >= height - 5;
    if (bottom && height === previousHeight) stable++; else stable=0;
    if (stable >= 2) break;
    previousHeight = height;
  }
  collectCards(); window.scrollTo(0,0);
  // In the legacy editor the option being edited appears in a dialog; capture it
  // without requiring a list page to be present underneath.
  const externalField = [...document.querySelectorAll('input[ng-model*="externalID"]')].find(visible);
  if (visible(externalField)) {
    const dialog = externalField.closest('.ngdialog,.modal,[role="dialog"],.extra-option-editor') || document.body;
    const title = clean(dialog.querySelector('h1,h2,h3,[class*="title"]')?.textContent || '');
    const productDialog = [...document.querySelectorAll('.ngdialog,[role="dialog"],[role="alertdialog"]')]
      .find((el) => visible(el) && /editar produto/i.test(clean(el.innerText)));
    const productName = clean(productDialog?.querySelector('input[ng-model*="newProduct.name" i],input[ng-model*="newProduct.Name"]')?.value || '');
    if (productName && /c[oó]digos e identifica[cç][aã]o/i.test(title)) {
      const key = `product:${normalizeName(productName)}:`;
      const existing = found.get(key);
      if (existing) existing.currentCode = clean(externalField.value);
      else add('product', productName, null, '', externalField.value);
    } else {
      const nameField = dialog.querySelector('input[ng-model*="name"],input[ng-model*="Name"],input[name*="name" i]');
      const name = clean(nameField?.value || title.replace(/^Editar (Complemento|Op[cç][aã]o)\s*/i, '') || '');
      if (name && !/^editar complemento$|^editar op[cç][aã]o$|^c[oó]digos e identifica[cç][aã]o$/i.test(name)) add('addon', name, dialog);
    }
  }
  // The product list does not render external IDs. When no editor is already
  // open, inspect each product's Codes dialog, read its value, then close both
  // dialogs with their X buttons without changing or saving the product.
  if (!editorWasAlreadyOpen) {
    const productRows = [...productCardKeys].map((key) => ({ key, record: found.get(key) })).filter((entry) => entry.record);
    const productCardSelector = '.item-card,[class*="item-card"],.product-card,[class*="product-card"],[data-cy*="product-card"]';
    const findCard = (record) => [...document.querySelectorAll(productCardSelector)].find((card) => {
      if (!isProductRow(card) || card.closest('.ngdialog,[role="dialog"],[role="alertdialog"]')) return false;
      const id = card.getAttribute('data-id') || card.getAttribute('data-product-id') || card.id || normalizeName(nameFrom(card));
      return String(id) === String(record.itemid) || normalizeName(nameFrom(card)) === normalizeName(record.name);
    });
    const findDialog = (pattern) => [...document.querySelectorAll('.ngdialog,[role="dialog"],[role="alertdialog"]')]
      .find((el) => visible(el) && pattern.test(clean(el.innerText)));
    const closeButton = (dialog) => [...(dialog?.querySelectorAll('button,[role="button"]') || [])].find((el) => {
      const label = clean(el.getAttribute('aria-label') || el.getAttribute('title') || '');
      return visible(el) && (/^(dismiss|fechar|close)$/i.test(label) || /^(×|x)$/i.test(clean(el.innerText)) || /ngdialog-close|modal-close/i.test(String(el.className || '')));
    });
    for (const { key, record } of productRows) {
      const card = findCard(record);
      if (!card) continue;
      card.scrollIntoView({ block: 'center' });
      const actions = card.querySelector('[data-cy="btnActionButton"]') || card.querySelector('.item-card__actions');
      const trigger = actions?.querySelector('.item-options') || actions?.querySelector('.dropdown > i') || actions?.querySelector('.dropdown') || actions;
      if (!trigger) continue;
      trigger.click();
      const menuCard = await waitFor(() => {
        const current = findCard(record);
        const edit = current?.querySelector('[data-cy="btnActionButtonEdit"]') || [...(current?.querySelectorAll('a,button,[role="button"]') || [])].find((el) => /^Editar$/i.test(clean(el.innerText || el.getAttribute('aria-label') || '')));
        return edit && visible(edit) ? { current, edit } : null;
      }, 16);
      if (!menuCard) continue;
      menuCard.edit.click();
      const productDialog = await waitFor(() => findDialog(/editar produto/i));
      if (!productDialog) continue;
      const codeAction = [...productDialog.querySelectorAll('button,a,[role="button"]')]
        .find((el) => visible(el) && /editar c[oó]digos dos produtos/i.test(clean(el.innerText)));
      if (codeAction) {
        codeAction.click();
        const codeDialog = await waitFor(() => findDialog(/c[oó]digos e identifica[cç][aã]o/i));
        const field = codeDialog?.querySelector('input[ng-model="newProduct.externalID"],input[ng-model*="externalID"]');
        if (field && visible(field)) record.currentCode = clean(field.value);
        if (codeDialog) {
          const closeCode = closeButton(codeDialog);
          if (closeCode) { closeCode.click(); await waitFor(() => !findDialog(/c[oó]digos e identifica[cç][aã]o/i)); }
        }
      }
      const currentProductDialog = findDialog(/editar produto/i);
      if (currentProductDialog) {
        const closeProduct = closeButton(currentProductDialog);
        if (closeProduct) { closeProduct.click(); await waitFor(() => !findDialog(/editar produto/i)); }
      }
      await wait(30);
    }
  }
  return [...found.values()];
}

async function applyMultipedidosCodes(changes) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalizeName = (value) => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim();
  const visible = (el) => {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const isProductRow = (el) => {
    if (!visible(el) || el.matches('category-card,[data-cy="categoryCard"],.category-card,[class*="category-card"]')) return false;
    const text = clean(el.innerText);
    return !/Novo item|Nenhum item/i.test(text);
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (test, tries = 35) => { for (let i=0;i<tries;i++) { const result=test(); if(result) return result; await wait(120); } return null; };
  const clickText = (pattern, root = document) => {
    const nodes = [...root.querySelectorAll('button,a,[role="button"],[ng-click],input[type="button"],input[type="submit"]')].filter(visible);
    const match = nodes.filter((el) => pattern.test(clean(el.innerText || el.value || el.getAttribute('aria-label') || el.title))).sort((a,b) => (a.innerText||'').length-(b.innerText||'').length)[0];
    match?.click(); return Boolean(match);
  };
  const expandProductCategories = async () => {
    const categorySelector = 'category-card,[data-cy="categoryCard"],.category-card,[class*="category-card"]';
    const categories = [...document.querySelectorAll(categorySelector)]
      .filter((el) => visible(el) && !el.parentElement?.closest(categorySelector));
    for (const category of categories) {
      const hasVisibleProduct = [...category.querySelectorAll('[data-cy="productCard"],product-card,.product-card,[class*="product-card"]')].some(visible);
      if (hasVisibleProduct) continue;
      const toggle = category.querySelector('.show-children');
      if (toggle && visible(toggle)) { toggle.click(); await wait(80); }
    }
  };
  const setExternalCode = (field, value) => {
    if (!field) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(field, String(value)); else field.value = String(value);
    field.dispatchEvent(new Event('input', { bubbles:true }));
    field.dispatchEvent(new Event('change', { bubbles:true }));
    field.dispatchEvent(new Event('blur', { bubbles:true }));
    return true;
  };
  let applied = 0, missing = 0;
  const appliedItems = [];
  const failures = [];
  const miss = (row, stage) => { missing++; failures.push(`${clean(row.name)}: ${stage}`); };
  await expandProductCategories();
  for (const row of changes) {
    try {
      const desired = normalizeName(row.name);
      if (row.kind === 'product') {
        const findProductCard = () => [...document.querySelectorAll('.item-card,[class*="item-card"],.product-card,[class*="product-card"],[data-cy*="product-card"]')]
          .filter((el) => isProductRow(el) && !el.closest('.ngdialog,[role="dialog"]'))
          .map((el) => ({ el, name: normalizeName(el.querySelector('.item-parent-name,.item-child-name,[class*="product-name"],[class*="item-name"],[class*="item-card__name"],[class*="title"],h2,h3,h4')?.textContent || el.innerText.split('\n').map((line) => line.trim()).find(Boolean) || '') }))
          .filter((x) => (x.name === desired || (desired.length > 5 && x.name.includes(desired))) && x.el.querySelector('.item-card__actions,[data-cy="btnActionButton"]'))
          .sort((a,b) => a.name.length-b.name.length)[0]?.el;
        const card = findProductCard();
        if (!card) { miss(row, 'produto pai não localizado'); continue; }
        card.scrollIntoView({ block: 'center' });
        // Do not match .item-card__children-actions (the “Novo complemento”
        // control). The product menu is specifically btnActionButton.
        const actions = card.querySelector('[data-cy="btnActionButton"]') || card.querySelector('.item-card__actions');
        if (!actions) { miss(row, 'menu do produto não localizado'); continue; }
        const menuTrigger = actions.querySelector('.item-options') || actions.querySelector('.dropdown > i') || actions.querySelector('.dropdown') || actions;
        menuTrigger.click(); await wait(150);
        // Opening the actions menu rerenders the product card in Angular. Resolve
        // the same named product again before clicking its own edit link.
        const menuCard = await waitFor(() => {
          const currentCard = findProductCard();
          const link = currentCard?.querySelector('[data-cy="btnActionButtonEdit"]')
            || [...(currentCard?.querySelectorAll('a,button,[role="button"]') || [])].find((el) => /^Editar$/i.test(clean(el.innerText || el.getAttribute('aria-label') || '')));
          return link && visible(link) ? currentCard : null;
        });
        const editLink = menuCard?.querySelector('[data-cy="btnActionButtonEdit"]')
          || [...(menuCard?.querySelectorAll('a,button,[role="button"]') || [])].find((el) => /^Editar$/i.test(clean(el.innerText || el.getAttribute('aria-label') || '')));
        if (!editLink) { miss(row, 'opção Editar não apareceu no menu deste produto'); continue; }
        editLink.click();
        const productDialog = await waitFor(() => [...document.querySelectorAll('[role="alertdialog"]')].find((el) => visible(el) && /editar produto/i.test(clean(el.innerText))));
        const productNameField = productDialog && await waitFor(() => [...productDialog.querySelectorAll('input[placeholder="Adicione um nome para o item"],input[ng-model*="newProduct.name" i],input[ng-model*="newProduct.Name"]')].find(visible));
        // Verify the opened editor is the same product row before touching its
        // external code. A missing name field is also a hard stop.
        if (!productNameField || normalizeName(productNameField.value) !== desired) {
          if (productDialog) clickText(/^Dismiss$/i, productDialog);
          miss(row, productNameField ? `cadastro aberto é “${clean(productNameField.value)}”` : 'formulário do produto não abriu'); continue;
        }
        const codeAction = [...productDialog.querySelectorAll('button,a,[role="button"]')].find((el) => visible(el) && /editar c[oó]digos dos produtos/i.test(clean(el.innerText)));
        if (!codeAction) { miss(row, 'botão de códigos não apareceu no produto'); continue; }
        codeAction.click();
        const codeDialog = await waitFor(() => [...document.querySelectorAll('[role="alertdialog"]')].find((el) => visible(el) && /c[oó]digos e identifica[cç][aã]o/i.test(clean(el.innerText))));
        const field = codeDialog?.querySelector('input[ng-model="newProduct.externalID"],input[ng-model*="externalID"]');
        if (!field || !visible(field) || !setExternalCode(field, row.code)) { miss(row, 'campo Código Externo não apareceu'); continue; }
        await wait(100);
        if (!clickText(/^(Finalizar edi[cç][aã]o|Concluir)$/i, codeDialog)) { miss(row, 'não foi possível concluir o código'); continue; }
        await wait(180);
        // The product editor wizard persists the edited product on its last step.
        let saved = false;
        for (let step=0; step<6; step++) {
          const currentDialog = [...document.querySelectorAll('[role="alertdialog"]')].find((el) => visible(el) && /editar produto/i.test(clean(el.innerText)));
          if (!currentDialog) break;
          const finish = [...currentDialog.querySelectorAll('button,[role="button"]')].find((el) => visible(el) && (/finalizar/i.test(clean(el.innerText)) || /finishCreation\(\)/.test(el.getAttribute('ng-click')||'')));
          if (finish) { finish.click(); saved = true; break; }
          const next = [...currentDialog.querySelectorAll('button,[role="button"]')].find((el) => visible(el) && /^pr[oó]ximo$/i.test(clean(el.innerText)));
          if (!next) break;
          next.click(); await wait(150);
        }
        if (!saved) { miss(row, 'etapas de edição não chegaram ao botão Finalizar'); continue; }
        // Wait for the save action to settle, then close the product editor with
        // its own X before the loop can open another product. Multipedidos can
        // leave the previous editor state active if another item opens first.
        await wait(500);
        const savedDialog = [...document.querySelectorAll('[role="alertdialog"]')]
          .find((el) => visible(el) && /editar produto/i.test(clean(el.innerText)));
        if (savedDialog) {
          const closeButton = [...savedDialog.querySelectorAll('button,[role="button"]')].find((el) =>
            visible(el) && (/^(dismiss|fechar|close|×|x)$/i.test(clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || ''))
              || /^(dismiss|fechar|close)$/i.test(clean(el.getAttribute('aria-label') || el.getAttribute('title') || ''))
              || /ngdialog-close|modal-close/i.test(el.className || '')));
          if (!closeButton) { miss(row, 'produto salvo, mas o X para fechar não apareceu'); continue; }
          closeButton.click();
          const closed = await waitFor(() => {
            const dialog = [...document.querySelectorAll('[role="alertdialog"]')]
              .find((el) => visible(el) && /editar produto/i.test(clean(el.innerText)));
            return dialog ? null : true;
          }, 30);
          if (!closed) { miss(row, 'produto salvo, mas a janela não fechou pelo X'); continue; }
        }
        applied++; appliedItems.push({ kind: row.kind, itemid: row.itemid, optionid: row.optionid || '' });
      } else {
        const openField = [...document.querySelectorAll('input[ng-model*="externalID"]')].find(visible);
        const openDialog = openField?.closest('.ngdialog,.modal,[role="dialog"],.extra-option-editor');
        if (openField && openDialog) {
          const modalName = normalizeName(openDialog.querySelector('input[ng-model*="name"],input[ng-model*="Name"],input[name*="name" i]')?.value || openDialog.querySelector('h1,h2,h3,[class*="title"]')?.textContent?.replace(/^Editar (Complemento|Op[cç][aã]o)\s*/i, '') || '');
          if (modalName && (modalName === desired || modalName.includes(desired) || desired.includes(modalName))) {
            setExternalCode(openField, row.code); await wait(100);
            if (clickText(/^(Concluir|Finalizar)$/i, openDialog)) { await wait(250); applied++; appliedItems.push({ kind: row.kind, itemid: row.itemid, optionid: row.optionid || '' }); continue; }
            missing++; continue;
          }
        }
        // Complement options are edited from the option card menu. Leave the
        // item untouched when its editor is not already visible on this page.
        const dialogs = [...document.querySelectorAll('.ngdialog,[role="dialog"]')].filter((el) => visible(el) && /adicionar complementos e varia[cç][oõ]es/i.test(clean(el.innerText)));
        const scope = dialogs[0] || document;
        const cards = [...scope.querySelectorAll('.item-card,[class*="item-card"],.extra-option-card,[class*="extra-option-card"],[class*="extra-option__card"],[class*="option-card"],[data-cy*="extra-option"]')].filter(visible);
        const card = cards.find((el) => normalizeName(el.innerText).includes(desired));
        if (!card) { missing++; continue; }
        const menu = card.querySelector('button[aria-label*="menu" i],button[aria-label*="mais" i],[class*="menu-button"],[class*="actions"] button,[class*="ellipsis"]');
        if (!menu) { missing++; continue; }
        menu.click(); await wait(100);
        if (!clickText(/^Editar$/i)) { missing++; continue; }
        const field = await waitFor(() => [...document.querySelectorAll('input[ng-model*="externalID"]')].find(visible));
        if (!field || !setExternalCode(field, row.code)) { missing++; continue; }
        await wait(100);
        if (!clickText(/^(Concluir|Finalizar)$/i)) { missing++; continue; }
        await wait(250); applied++; appliedItems.push({ kind: row.kind, itemid: row.itemid, optionid: row.optionid || '' });
      }
    } catch { missing++; }
  }
  const complementDialog = [...document.querySelectorAll('.ngdialog,[role="dialog"]')]
    .find((el) => visible(el) && /adicionar complementos e varia[cç][oõ]es/i.test(clean(el.innerText)));
  if (complementDialog && appliedItems.some((item) => item.kind !== 'product')) {
    const finishGroup = [...complementDialog.querySelectorAll('button,[role="button"]')]
      .find((el) => visible(el) && /^concluir$/i.test(clean(el.innerText)));
    if (finishGroup) { finishGroup.click(); await wait(300); }
  }
  return { applied, missing, appliedItems, failures };
}

function scanIfoodPage() {
  const visible = (el) => { const r=el.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const nearbyName = (input, selector, depth) => {
    let box=input; for(let n=0;n<depth && box.parentElement;n++) box=box.parentElement;
    const els=[...box.querySelectorAll(selector)].filter(visible);
    if(!els.length) return '';
    const rect=input.getBoundingClientRect(), mid=(rect.top+rect.bottom)/2;
    return els.sort((a,b)=>Math.abs((a.getBoundingClientRect().top+a.getBoundingClientRect().bottom)/2-mid)-Math.abs((b.getBoundingClientRect().top+b.getBoundingClientRect().bottom)/2-mid))[0].innerText.trim();
  };
  const found = new Map();
  const collect = () => {
    for(const input of document.querySelectorAll('input[data-testid="item-pdv-input"]')) {
      const card=input.closest('[data-testid^="item-card-"]') || input.parentElement;
      const name=nearbyName(input,'span[class*="link-text__content"]',10) || card.innerText.split('\n')[0]?.trim() || '';
      const itemid=input.getAttribute('itemid') || card.getAttribute('data-testid')?.replace('item-card-','') || '';
      if(name && itemid) found.set(`p:${itemid}`,{kind:'product', name, parentName:'', groupName:'', currentCode:input.value, itemid, optionid:'', inputId:input.id || ''});
    }
    for(const input of document.querySelectorAll('input[data-testid="option-pdv-input"]')) {
      const card=input.closest('[data-testid^="item-card-"]') || input.parentElement;
      const itemInput=card.querySelector('input[data-testid="item-pdv-input"]');
      const parentName=itemInput ? nearbyName(itemInput,'span[class*="link-text__content"]',10) : '';
      const name=nearbyName(input,'span[class*="link-text__content"]',14);
      const groupName=nearbyName(input,'p.sc-sSmyr',14);
      const text=`${groupName} ${name}`.toLocaleLowerCase('pt-BR');
      const kind=/tamanho|\bsize\b/.test(text) ? 'size' : /sabor/.test(text) ? 'flavor' : 'addon';
      const itemid=input.getAttribute('itemid') || '';
      const optionid=input.getAttribute('optionid') || '';
      if(name && itemid && optionid) found.set(`o:${itemid}:${optionid}`,{kind,name,parentName,groupName,currentCode:input.value,itemid,optionid,inputId:input.id || ''});
    }
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
  let lastHeight=-1, stable=0;
  return (async () => {
    for(let round=0;round<80;round++) {
      for(const toggle of document.querySelectorAll('label[class*="_selectable-chip-wrapper_"]')) {
        if(/^Complementos/i.test(toggle.innerText.trim()) && !/chips--checked/.test(toggle.className)) toggle.click();
      }
      await wait(100); collect();
      window.scrollBy(0,Math.round(window.innerHeight*0.82)); await wait(180);
      const height=document.body.scrollHeight, bottom=window.innerHeight+window.scrollY>=height-5;
      if(bottom && height===lastHeight) stable++; else stable=0;
      if(stable>=2) break;
      lastHeight=height;
    }
    collect(); window.scrollTo(0,0); return [...found.values()];
  })();
}

async function applyIfoodCodes(changes) {
  let applied=0, missing=0;
  for(const row of changes) {
    const find=()=>row.optionid
      ? document.querySelector(`input[data-testid="option-pdv-input"][itemid="${CSS.escape(row.itemid)}"][optionid="${CSS.escape(row.optionid)}"]`)
      : document.querySelector(`input[data-testid="item-pdv-input"][itemid="${CSS.escape(row.itemid)}"]`);
    let input=find(), height=-1, stable=0;
    for(let n=0;n<70 && !input;n++) {
      window.scrollBy(0,Math.round(window.innerHeight*0.82)); await new Promise((resolve)=>setTimeout(resolve,160)); input=find();
      const bottom=window.innerHeight+window.scrollY>=document.body.scrollHeight-5;
      if(bottom && document.body.scrollHeight===height) stable++; else stable=0;
      if(stable>=2) break; height=document.body.scrollHeight;
    }
    if(!input) { missing++; continue; }
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    input.focus(); setter.call(input,row.code);
    input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
    const last=row.code.slice(-1);
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:last})); input.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:last}));
    input.blur(); applied++; await new Promise((resolve)=>setTimeout(resolve,500));
  }
  window.scrollTo(0,0); return {applied,missing};
}
