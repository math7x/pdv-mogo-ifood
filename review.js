const statusEl = document.getElementById('rv-final-summary');
const resultsEl = document.getElementById('rv-main');
const summaryEl = document.getElementById('rv-summary-bar');
const applyButton = document.getElementById('rv-btn-apply');
const emptyEl = document.getElementById('rv-empty');
let currentPlan = [];
let activeTab = 'option';
let allMogoRecords = [];
let mogoActiveTabUrl = '';

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
function makeCode(kind, id) { return kind === 'product' ? String(id) : ({ addon: `AD${id}`, size: `PZ${id}`, flavor: `S${id}` }[kind] || String(id)); }
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
async function savePlan() { await chrome.storage.local.set({ mogoReviewPlan: currentPlan }); }

document.getElementById('scan').addEventListener('click', async () => {
  const button = document.getElementById('scan'); button.disabled = true;
  setStatus('Lendo os itens e opções do iFood...');
  try {
    const { mogoRecords = [] } = await chrome.storage.local.get('mogoRecords');
    if (!mogoRecords.length) throw new Error('Capture primeiro os cadastros da Mogo.');
    allMogoRecords = mogoRecords;
    const tab = await getIfoodTab();
    if (!tab?.id) throw new Error('Não encontrei o Portal iFood aberto na tela Cardápio > Integração com PDV.');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanIfoodPage });
    const targets = result || [];
    if (!targets.length) throw new Error('Não encontrei campos de código PDV. Confira se o cardápio terminou de carregar.');
    currentPlan = targets.map((target) => {
      const options = mogoRecords
        .filter((r) => r.kind === target.kind)
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
    const selected = currentPlan.filter((r) => r.selected).length;
    setStatus(`${targets.length} campos lidos. ${selected} correspondência(s) exata(s) pré-selecionada(s); confira antes de aplicar.`, 'rv-message-ok');
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
      const table=`<div class="rv-table-scroll"><table class="rv-table"><thead><tr><th>Aplicar</th><th>Tipo</th><th>Item no iFood</th><th>Correspondência na Mogo</th><th>Código atual</th><th>Novo código PDV</th><th>Resultado</th></tr></thead><tbody>${matches.map(rowHtml).join('')}</tbody></table></div>`;
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
  if (!confirm(`Preencher ${changes.length} código(s) na aba do iFood? Confira se esta é a loja correta.`)) return;
  applyButton.disabled = true;
  setStatus(`Preenchendo ${changes.length} código(s) no iFood...`);
  try {
    const tab = await getIfoodTab();
    if (!tab?.id) throw new Error('A aba do iFood foi fechada.');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: applyIfoodCodes, args: [changes] });
    for (const item of changes) {
      const stored = currentPlan.find((r) => r.itemid===item.itemid && r.optionid===item.optionid && r.kind===item.kind);
      if (stored) { stored.currentCode=item.code; stored.selected=false; stored.status='applied'; }
    }
    await savePlan(); render();
    setStatus(`${result.applied} código(s) preenchido(s). ${result.missing ? `${result.missing} campo(s) não foram encontrados; atualize a leitura antes de tentar novamente.` : 'Confira o resultado na página do iFood.'}`, result.missing ? 'rv-message-error' : 'rv-message-ok');
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

chrome.storage.local.get(['mogoReviewPlan','mogoRecords','mogoActiveTabUrl']).then(({ mogoReviewPlan, mogoRecords, mogoActiveTabUrl: savedMogoUrl }) => {
  allMogoRecords = mogoRecords || [];
  mogoActiveTabUrl = savedMogoUrl || '';
  if (Array.isArray(mogoReviewPlan) && mogoReviewPlan.length) {
    currentPlan = upgradeSavedPlan(mogoReviewPlan);
    savePlan();
    render();
    setStatus('Revisão anterior carregada. Leia novamente se você alterou o cardápio.', 'rv-message-ok');
  }
});

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
