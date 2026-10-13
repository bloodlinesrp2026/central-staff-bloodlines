// Módulo de Allowlist e Entrevistas (documento 02). Funções puras, sem DOM nem rede:
// a interface (Etapa 6), o mock e a Edge Function do Discord (Etapa 7) usam as mesmas regras.
// Etapa 4: constantes e mensagens que o banco (supabase/10_allowlist.sql) também usa;
// tests/db/banco.test.mjs confere que são iguais.
// Etapa 5: status automático, mensagens, idade, nomes proibidos, Copiar e card do Discord,
// reproduzindo o HTML antigo (seções 2 a 4 do documento 02) com as Decisões 3, 4, 5, 12 e 13.
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';

/** Tipos de registro. */
export const AL_KINDS = Object.freeze(['allowlist', 'entrevista']);
export const AL_STATUSES = Object.freeze(['aprovado', 'reprovado']);

/** Os 5 botões de avaliação (seção 2.3). ev1/ev4 e ev2/ev3 se excluem. */
export const EVAL_FLAGS = Object.freeze({
  ev1: 'Bom Conhecimento das regras da cidade',
  ev2: 'Bom Conhecimento da LORE da cidade',
  ev3: 'Não tem Conhecimento da LORE da cidade',
  ev4: 'Não tem Conhecimento das regras da cidade',
  ev5: 'Personagem mal desenvolvido',
});

/** Tipos de pergunta do gabarito e o nome do selo na tela. */
export const QUESTION_KINDS = Object.freeze({
  lore: 'Lore', rp: 'RP', regra: 'Regra', pratica: 'Prática', interpretacao: 'Interp.',
});
export const QUESTION_SECTIONS = Object.freeze(['Lore do servidor', 'Conceitos e Regras do RP', 'Situações práticas']);

/** Papéis numa análise ou entrevista (documento 01, seção 5.2). */
export const PARTICIPANT_ROLES = Object.freeze(['responsavel', 'entrevistador', 'acompanhante']);

/** Prints: limites do bucket al-prints. */
export const MAX_PRINTS = 9;
export const MAX_PRINT_BYTES = 8 * 1024 * 1024;
export const PRINT_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
/** Decisão 6: os prints são apagados depois deste prazo (a análise continua). */
export const PRINT_RETENTION_DAYS = 90;

/** Finalidades de webhook (seção 13.2). */
export const WEBHOOK_PURPOSES = Object.freeze(['allowlist', 'entrevista', 'avisos', 'outro']);

/** Mensagens das travas. IGUAIS às de supabase/10_allowlist.sql. */
export const ALLOWLIST_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não permite analisar allowlists nem fazer entrevistas.',
  notAuthor: 'Só quem fez a análise pode alterá-la.',
  sent: 'Esta análise já foi enviada ao Discord e não pode mais ser editada.',
  minor: 'Menor de 18 anos: a análise só pode ser Reprovada.',
  conflict: 'A avaliação tem opções que se contradizem (bom e sem conhecimento ao mesmo tempo).',
  answersOnlyInterview: 'As perguntas do gabarito só valem para entrevistas.',
  printFolder: 'O print precisa ficar na pasta da própria análise.',
  maxPrints: 'Máximo de 9 imagens por análise.',
  nameInUse: 'Nomes "Em uso na cidade" são cadastrados pela tela de Personagens.',
  nameDuplicate: 'Este nome já está na lista de nomes proibidos.',
  webhookUrl: 'Use o endereço de webhook do Discord (https://discord.com/api/webhooks/...).',
});

/** Mensagens dos campos (só no site; o banco recusa com as mesmas regras pelos CHECKs). */
export const AL_FIELD_ERRORS = Object.freeze({
  kind: 'Tipo inválido (allowlist ou entrevista).',
  status: 'Escolha Aprovada ou Reprovada.',
  discordId: 'Discord ID: só números, de 17 a 20 dígitos.',
  age: 'Idade: número de 1 a 120.',
  flags: 'Avaliação: opção desconhecida.',
  checklistOnlyInterview: 'O checklist só vale para entrevistas.',
  participant: 'Participante: Discord ID de 17 a 20 dígitos e papel entrevistador ou acompanhante.',
  question: 'Pergunta: texto de 1 a 500 caracteres.',
  printType: 'Só imagens PNG, JPG ou WEBP.',
  printSize: 'Cada imagem pode ter até 8 MB.',
  webhookName: 'Nome: de 1 a 80 caracteres.',
  webhookPurpose: 'Finalidade inválida.',
  webhookAvatar: 'Foto do remetente: endereço https:// de uma imagem.',
  max: (n) => `Até ${n} caracteres.`,
});

export const AL_LIMITS = Object.freeze({
  al_id: 100, author_handle: 100, character_name: 100, submitted_at_text: 100, reason: 2000, notes: 4000,
  note: 2000, question_text: 500, checklist: 100, channel_name: 80, sender_name: 80, sender_avatar_url: 500,
});

/* ======================= Discord: canais, cores e assinatura ======================= */
/** Canais citados nas mensagens (IDs de canal, não são segredo). */
export const DISCORD_CHANNELS = Object.freeze({
  regras: '<#1419521434148933715>',
  lore: '<#1419521434148933714>',
  ticket: '<#1419521433305878623>',
  personagens: '<#1428094063378436340>',
});
export const SIGNATURE = '-# **`⛧°. ⋆༺♱Equipe Bloodlines RP♱༻⋆. °⛧`**';
export const STATUS_COLORS = Object.freeze({ aprovado: 0x3DAA6A, reprovado: 0xC8365A });
/** Limites do Discord: campo, bloco do gabarito (como o HTML), campos e caracteres por card. */
export const DISCORD_LIMITS = Object.freeze({ field: 1024, chunk: 1000, fields: 25, embed: 6000, files: 10 });
/** Aviso em versão texto: U+26A0 + U+FE0E (nunca U+FE0F, que vira emoji). */
export const WARN_TEXT = String.fromCharCode(0x26A0, 0xFE0E);
const WARN = WARN_TEXT;
const EMPTY = '—';

/* ======================= Avaliação, status e idade ======================= */
export const MIN_AGE = 18;
const CONFLICTS = Object.freeze({ ev1: 'ev4', ev4: 'ev1', ev2: 'ev3', ev3: 'ev2' });
const FLAG_ORDER = Object.keys(EVAL_FLAGS);
const sortFlags = (flags) => FLAG_ORDER.filter((f) => flags.includes(f));

/**
 * Liga/desliga um botão de avaliação. Ligar um desliga o oposto (ev1×ev4, ev2×ev3).
 * @param {string[]} flags @param {string} flag @returns {string[]} nova lista, em ordem
 */
export function toggleFlag(flags = [], flag) {
  if (!FLAG_ORDER.includes(flag)) return sortFlags(flags);
  if (flags.includes(flag)) return sortFlags(flags.filter((f) => f !== flag));
  return sortFlags([...flags.filter((f) => f !== CONFLICTS[flag]), flag]);
}

/** As opções se contradizem? (bom e sem conhecimento ao mesmo tempo) */
export const hasFlagConflict = (flags = []) =>
  (flags.includes('ev1') && flags.includes('ev4')) || (flags.includes('ev2') && flags.includes('ev3'));

/**
 * Idade digitada → número inteiro de 1 a 120, ou null (vazio ou inválido).
 * @param {unknown} value
 */
export function parseAge(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : null;
}

/** Menor de 18 anos? (idade vazia ou inválida = não) */
export const isMinor = (age) => {
  const n = parseAge(age);
  return n !== null && n < MIN_AGE;
};

/**
 * Status automático pelos botões (seção 2.3): ev5, ev3 ou ev4 → Reprovada; ev1 e ev2 → Aprovada;
 * senão null (o status não muda sozinho).
 */
export function autoStatus(flags = []) {
  if (flags.includes('ev5') || flags.includes('ev3') || flags.includes('ev4')) return 'reprovado';
  if (flags.includes('ev1') && flags.includes('ev2')) return 'aprovado';
  return null;
}

/**
 * Status depois de um clique: menor de 18 sempre Reprovada; senão o automático; senão o atual.
 * @param {'aprovado'|'reprovado'|null} current
 */
export function nextStatus(current, flags = [], age = null) {
  if (isMinor(age)) return 'reprovado';
  return autoStatus(flags) ?? current ?? null;
}

const { regras: CH_REGRAS, lore: CH_LORE, ticket: CH_TICKET, personagens: CH_PERSONAGENS } = DISCORD_CHANNELS;

/** Mensagens automáticas: a primeira regra que bater vale (seções 2.3 e 4.2). */
const AUTO_MESSAGES = Object.freeze({
  allowlist: {
    minor: 'Você precisa ter 18 anos ou mais para participar. Volte quando for maior de idade!',
    ev5ev1ev2: 'Você demonstrou bom conhecimento das regras e da Lore. Entretanto, seu personagem não está de acordo com a Lore da cidade. Refaça o formulário de Allowlist.',
    ev5: 'Seu personagem não está de acordo com a Lore da cidade. Recomendamos que revise a Lore e refaça o formulário de Allowlist.',
    ev1ev2: `Você demonstrou bom conhecimento das regras e da Lore do servidor. \n\nRecomendamos que releia os chats abaixo antes da entrevista.\n> ➛ Regras ${CH_REGRAS}\n> ➛ Lore ${CH_LORE}`,
    ev1ev3: `Você demonstrou bom conhecimento das regras da cidade. Entretanto, algumas respostas relacionadas à Lore estavam incorretas. Recomendamos que releia atentamente a Lore ${CH_LORE} da cidade e, após isso, refaça o formulário de Allowlist.`,
    ev2ev4: `Você demonstrou bom conhecimento da Lore da cidade, mas apresentou erros nas perguntas sobre as regras. Recomendamos que releia as regras ${CH_REGRAS} da cidade e refaça o formulário de Allowlist.`,
    ev3ev4: `Você apresentou dificuldades tanto nas perguntas sobre as regras quanto nas questões relacionadas à Lore. Recomendamos que releia atentamente as regras ${CH_REGRAS} e a Lore ${CH_LORE} da cidade antes de refazer o formulário de Allowlist.`,
    ev4: 'Você apresentou erros nas perguntas sobre as regras da cidade. Recomendamos que releia atentamente as regras e refaça o formulário de Allowlist.',
    ev3: `Você apresentou erros nas perguntas relacionadas à Lore da cidade. Recomendamos que releia atentamente a Lore ${CH_LORE} e refaça o formulário de Allowlist.`,
  },
  entrevista: {
    minor: 'Você precisa ter 18 anos ou mais para participar da entrevista. Volte quando for maior de idade!',
    ev5ev1ev2: 'Você demonstrou bom conhecimento das regras e da Lore. Entretanto, seu personagem não está de acordo com a Lore da cidade. Refaça a entrevista.',
    ev5: 'Seu personagem não está de acordo com a Lore da cidade. Recomendamos que revise a Lore e refaça a entrevista.',
    ev1ev2: '`Você demonstrou bom conhecimento das regras e da Lore do servidor.`',
    ev1ev3: 'Você demonstrou bom conhecimento das regras da cidade. Entretanto, algumas respostas relacionadas à Lore estavam incorretas. Recomendamos que releia atentamente a Lore da cidade e, após isso, refaça a entrevista.',
    ev2ev4: 'Você demonstrou bom conhecimento da Lore da cidade, mas apresentou erros nas perguntas sobre as regras. Recomendamos que releia as regras da cidade e refaça a entrevista.',
    ev3ev4: 'Você apresentou dificuldades tanto nas perguntas sobre as regras quanto nas questões relacionadas à Lore. Recomendamos que releia atentamente as regras e a Lore da cidade antes de refazer a entrevista.',
    ev4: 'Você apresentou erros nas perguntas sobre as regras da cidade. Recomendamos que releia atentamente as regras e refaça a entrevista.',
    ev3: 'Você apresentou erros nas perguntas relacionadas à Lore da cidade. Recomendamos que releia atentamente a Lore e refaça a entrevista.',
  },
});

/**
 * Mensagem automática (motivo sugerido). Na entrevista, a idade é a da própria entrevista
 * (o HTML olhava a da aba Allowlist; corrigido, seção 7 item 3).
 * @param {'allowlist'|'entrevista'} kind
 * @param {{ flags?: string[], age?: unknown }} input
 */
export function autoMessage(kind, { flags = [], age = null } = {}) {
  const m = AUTO_MESSAGES[kind] ?? AUTO_MESSAGES.allowlist;
  const has = (f) => flags.includes(f);
  if (isMinor(age)) return m.minor;
  if (has('ev5') && has('ev1') && has('ev2')) return m.ev5ev1ev2;
  if (has('ev5')) return m.ev5;
  if (has('ev1') && has('ev2')) return m.ev1ev2;
  if (has('ev1') && has('ev3')) return m.ev1ev3;
  if (has('ev2') && has('ev4')) return m.ev2ev4;
  if (has('ev3') && has('ev4')) return m.ev3ev4;
  if (has('ev4')) return m.ev4;
  if (has('ev3')) return m.ev3;
  return '';
}

/* ======================= Nomes de personagem proibidos ======================= */
const ACCENTS = { á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', ç: 'c', ñ: 'n', ý: 'y', ÿ: 'y' };

/**
 * Forma de comparar nomes: minúsculas, sem acentos, sem apóstrofos, espaços simples.
 * Mesma regra de public.kb_name_norm() no banco (o teste confere com vários exemplos).
 * @param {string} name
 */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[áàâãäåéèêëíìîïóòôõöúùûüçñýÿ]/g, (c) => ACCENTS[c])
    .replace(/['’‘`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chave da checagem: normalizeName sem pontos ("St. John" = "St John"). */
const matchKey = (name) => normalizeName(name).replace(/\./g, '').replace(/\s+/g, ' ').trim();

/**
 * Monta o índice da checagem a partir da lista de blocked_names (só as ativas contam).
 * @param {Array<{ name: string, kind: 'nome'|'sobrenome', reason?: string, series?: string, reason_text?: string, mode?: string, active?: boolean }>} list
 */
export function buildNameIndex(list = []) {
  const full = new Map();
  const surname = new Map();
  const single = new Map();
  const add = (map, key, entry) => { if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  for (const entry of list) {
    if (!entry || entry.active === false) continue;
    const key = matchKey(entry.name);
    if (!key) continue;
    if (entry.kind === 'sobrenome') add(surname, key, entry);
    else {
      add(full, key, entry);
      if (!key.includes(' ')) add(single, key, entry);
    }
  }
  return { full, surname, single };
}

const MODE_RANK = { bloqueia: 2, alerta: 1 };
const TYPE_RANK = { nome: 3, sobrenome: 2, nome_parcial: 1 };

function describe(match) {
  const { entry, type, level } = match;
  const name = entry.name;
  const reason = entry.reason ?? 'serie';
  const series = entry.series ?? '';
  if (reason === 'em_uso') {
    return {
      title: 'Nome já em uso na cidade',
      warning: `${name} já está em uso na cidade por outro player. O player precisa escolher outro nome antes da aprovação.`,
      feedback: level === 'bloqueia' ? `"${name}" já está em uso na cidade. O player precisa escolher outro nome antes de iniciar o RP.` : null,
    };
  }
  const why = reason === 'outro' ? (entry.reason_text || 'nome não permitido') : null;
  if (type === 'sobrenome') {
    return {
      title: level === 'bloqueia' ? 'Sobrenome de personagem bloqueado' : 'Sobrenome para conferir',
      warning: why
        ? `O sobrenome ${name} não é permitido: ${why}.`
        : level === 'bloqueia'
          ? `O sobrenome ${name} pertence a personagens canônicos de ${series}. O player precisa escolher um sobrenome original.`
          : `O sobrenome ${name} também é de personagens de ${series}. Confira se o nome não copia um personagem canônico.`,
      feedback: level === 'bloqueia'
        ? (why ? `O sobrenome "${name}" não é permitido. Escolha um sobrenome original antes de iniciar o RP.`
          : `O sobrenome "${name}" pertence a personagens canônicos de ${series}. Veja o chat PERSONAGENS ${CH_PERSONAGENS} e depois escolha um sobrenome original antes de iniciar o RP.`)
        : null,
    };
  }
  if (type === 'nome_parcial') {
    return {
      title: 'Nome para conferir',
      warning: why
        ? `O nome contém ${name}, que não é permitido: ${why}. Confira antes de aprovar.`
        : `O nome contém ${name}, personagem canônico de ${series}. Confira se o nome não copia o personagem.`,
      feedback: null,
    };
  }
  return {
    title: level === 'bloqueia' ? 'Nome de personagem bloqueado' : 'Nome para conferir',
    warning: why
      ? `${name} não é permitido: ${why}. O player precisa escolher outro nome antes da aprovação.`
      : `${name} é um personagem canônico de ${series}. O player precisa escolher outro nome antes da aprovação.`,
    feedback: level === 'bloqueia'
      ? (why ? `"${name}" não é permitido. O player precisa escolher outro nome antes de iniciar o RP.`
        : `"${name}" é um personagem canônico de ${series}. O player precisa escolher outro nome antes de iniciar o RP.`)
      : null,
  };
}

/**
 * Checa o nome do personagem contra a lista de nomes proibidos (seções 2.4 e 12.2).
 *   1. Nome inteiro igual a um nome da lista → modo da entrada (normalmente bloqueia).
 *   2. Qualquer palavra (3+ letras) ou par de palavras ("De Martel", "St. John") igual a um
 *      sobrenome da lista → modo do sobrenome (Decisões 3 e 13: comuns só alertam).
 *   3. Nome de uma palavra só da lista ("Klaus") aparecendo junto com outro → só alerta (Decisão 12).
 * Não reprova sozinho: devolve o aviso mais grave e todos os que bateram, ou null.
 * @param {string} characterName
 * @param {ReturnType<typeof buildNameIndex>|object[]} indexOrList
 * @returns {null | { level: 'bloqueia'|'alerta', type: 'nome'|'sobrenome'|'nome_parcial', entry: object,
 *   title: string, warning: string, feedback: string|null, matches: object[] }}
 */
export function checkCharacterName(characterName, indexOrList) {
  const index = Array.isArray(indexOrList) ? buildNameIndex(indexOrList) : indexOrList;
  const key = matchKey(characterName);
  if (!key || !index) return null;
  const words = key.split(' ');
  const found = [];
  const push = (entries, type, forced) => {
    for (const entry of entries ?? []) {
      const level = forced ?? (entry.mode === 'alerta' ? 'alerta' : 'bloqueia');
      found.push({ entry, type, level });
    }
  };
  push(index.full.get(key), 'nome');
  for (const w of words) if (w.length >= 3) push(index.surname.get(w), 'sobrenome');
  for (let i = 0; i < words.length - 1; i++) push(index.surname.get(`${words[i]} ${words[i + 1]}`), 'sobrenome');
  if (words.length > 1) for (const w of words) push(index.single.get(w), 'nome_parcial', 'alerta');
  if (!found.length) return null;
  const seen = new Set();
  const matches = found
    .sort((a, b) => MODE_RANK[b.level] - MODE_RANK[a.level] || TYPE_RANK[b.type] - TYPE_RANK[a.type])
    .filter((m) => {
      const k = `${m.type}|${m.entry.id ?? m.entry.name}|${m.entry.series ?? ''}`;
      return seen.has(k) ? false : seen.add(k);
    })
    .map((m) => ({ ...m, ...describe(m) }));
  return { ...matches[0], matches };
}

/* ======================= Datas no formato do HTML ======================= */
export const TIME_ZONE = 'America/Sao_Paulo';
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    weekday: EN_WEEKDAYS.indexOf(get('weekday')), year: Number(get('year')), month: Number(get('month')),
    day: Number(get('day')), hour: get('hour').padStart(2, '0'), minute: get('minute').padStart(2, '0'),
  };
}

/** Botão "Agora": "sábado, 8 de agosto de 2026 18:50" (horário de Brasília). */
export function formatSubmittedAt(date = new Date(), timeZone = TIME_ZONE) {
  const p = dateParts(date, timeZone);
  return `${WEEKDAYS[p.weekday]}, ${p.day} de ${MONTHS[p.month - 1]} de ${p.year} ${p.hour}:${p.minute}`;
}

/** "Analisada em": "08/08/2026 às 18:50" (horário de Brasília). */
export function formatAnalyzedAt(date = new Date(), timeZone = TIME_ZONE) {
  const p = dateParts(date, timeZone);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year} às ${p.hour}:${p.minute}`;
}

/* ======================= Checklist da entrevista ======================= */
/**
 * Progresso do checklist (seção 3), agrupado por etapa.
 * @param {Array<{ id: string, stage: number, stage_title: string, text: string, hint?: string, position?: number, active?: boolean }>} items
 * @param {Iterable<string>} checkedIds
 */
export function checklistProgress(items = [], checkedIds = []) {
  const checked = new Set(checkedIds);
  const active = items.filter((i) => i.active !== false)
    .sort((a, b) => a.stage - b.stage || (a.position ?? 0) - (b.position ?? 0));
  const stages = [];
  for (const i of active) {
    let s = stages.find((x) => x.stage === i.stage);
    if (!s) { s = { stage: i.stage, title: i.stage_title, items: [] }; stages.push(s); }
    s.items.push({ id: i.id, text: i.text, hint: i.hint ?? '', done: checked.has(i.id) });
  }
  const done = active.filter((i) => checked.has(i.id)).length;
  return { done, total: active.length, complete: active.length > 0 && done === active.length, stages };
}

/** Itens marcados no formato gravado em al_evaluations.checklist (cópia do texto na hora). */
export const checklistSnapshot = (items = [], checkedIds = []) => {
  const checked = new Set(checkedIds);
  return items.filter((i) => checked.has(i.id)).map((i) => ({ item_id: i.id, stage: i.stage, text: i.text }));
};

/* ======================= Mensagem para o player e Copiar ======================= */
const clean = (v) => String(v ?? '').trim();

/**
 * Mensagem do preview (seção 2.5), em Markdown (renderizar com js/core/render-md.js).
 * @param {{ status: 'aprovado'|'reprovado', author_handle?: string, eval_flags?: string[], player_age?: unknown, reason?: string }} ev
 */
export function playerMessage(ev) {
  const name = clean(ev.author_handle) || 'você';
  const lines = [];
  if (ev.status === 'aprovado') {
    lines.push(`Olá, **${name}**! Sua allowlist foi analisada e **aprovada**.`);
    const extra = autoMessage('allowlist', { flags: ev.eval_flags, age: ev.player_age });
    if (extra) lines.push(`*${extra.trim()}*`);
    lines.push('Aguarde ser chamado(a) para a entrevista. Fique de olho no servidor!');
  } else {
    lines.push(`Olá, **${name}**! Sua allowlist foi analisada e **reprovada**.`);
    if (clean(ev.reason)) lines.push(`*${clean(ev.reason)}*`);
    lines.push(`Qualquer dúvida, abra um ticket ${CH_TICKET}.`);
  }
  return lines.join('\n\n');
}

/**
 * Texto do botão Copiar da análise de allowlist (seção 2.6), igual ao do HTML.
 * Nome: o do personagem; senão o autor; senão "[nome do personagem]".
 */
export function copyText(ev) {
  const name = clean(ev.character_name) || clean(ev.author_handle) || '[nome do personagem]';
  let t;
  if (ev.status === 'aprovado') {
    t = `**ALLOWLIST APROVADA** ꪜ\n\nOlá, ${name}! Sua allowlist foi analisada e **aprovada**.`;
    const extra = autoMessage('allowlist', { flags: ev.eval_flags, age: ev.player_age });
    if (extra) t += `\n\n${extra}`;
    t += `\n\nAguarde ser chamado(a) para a entrevista. Fique de olho no servidor!\n\n${SIGNATURE}`;
  } else {
    t = `**ALLOWLIST REPROVADA** ✗\n\nOlá, ${name}! Sua allowlist foi analisada e **reprovada**.`;
    if (clean(ev.reason)) t += `\n\n${clean(ev.reason)}`;
    t += `\n\nQualquer dúvida, abra um ticket ${CH_TICKET}.\n\n${SIGNATURE}`;
  }
  return t;
}

/* ======================= Card do Discord ======================= */
/**
 * Divide itens em blocos de até `max` caracteres (como o HTML: itens separados por linha em
 * branco). Um item maior que o bloco é cortado em pedaços.
 * @param {string[]} items @param {number} [max]
 */
export function splitIntoChunks(items, max = DISCORD_LIMITS.chunk) {
  const pieces = [];
  for (const raw of items) {
    const item = String(raw ?? '').trim();
    if (!item) continue;
    for (let i = 0; i < item.length; i += max) pieces.push(item.slice(i, i + max));
  }
  const chunks = [];
  let chunk = '';
  for (const p of pieces) {
    const next = chunk ? `${chunk}\n\n${p}` : p;
    if (next.length > max) { chunks.push(chunk); chunk = p; } else chunk = next;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

const numbered = (name, chunks) => chunks.map((value, i) => ({ name: i ? `${name} (${i + 1})` : name, value, inline: false }));
const orEmpty = (v) => clean(v) || EMPTY;

/** Linhas da avaliação no card (seção 2.7; na entrevista o ev5 vem sem o complemento). */
export function evaluationLines(kind, flags = []) {
  const lines = [];
  if (flags.includes('ev1')) lines.push(`ꪜ ${EVAL_FLAGS.ev1}`);
  if (flags.includes('ev2')) lines.push(`ꪜ ${EVAL_FLAGS.ev2}`);
  if (flags.includes('ev3')) lines.push(`✘ ${EVAL_FLAGS.ev3}`);
  if (flags.includes('ev4')) lines.push(`✘ ${EVAL_FLAGS.ev4}`);
  if (flags.includes('ev5')) {
    lines.push(kind === 'allowlist' ? `${WARN} **${EVAL_FLAGS.ev5}** — sugerimos que refaça a allowlist` : `${WARN} **${EVAL_FLAGS.ev5}**`);
  }
  return lines;
}

/** Nome do arquivo do print no Discord: anexo1.png, anexo2.jpg... */
export function printFileName(index, mimeOrName = '') {
  const s = String(mimeOrName).toLowerCase();
  const ext = s.includes('/') ? s.split('/')[1] : s.includes('.') ? s.slice(s.lastIndexOf('.') + 1) : 'png';
  return `anexo${index + 1}.${(ext || 'png').replace('jpeg', 'jpg')}`;
}

const embedSize = (e) => (e.title?.length ?? 0) + (e.footer?.text?.length ?? 0)
  + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/**
 * Monta as mensagens do webhook (seções 2.7 e 4.4). Normalmente uma só; se motivo, observações
 * e gabarito passarem dos limites do Discord (25 campos ou 6000 caracteres por card), o resto
 * vai em mensagens de continuação. Os prints (até 9) vão só na primeira; o primeiro aparece grande no card.
 * @param {object} ev análise (campos de al_evaluations)
 * @param {{
 *   responsibleName?: string,                             nome na staff de quem avaliou
 *   answers?: Array<{ question_text: string, note?: string, send_to_discord?: boolean, position?: number }>,
 *   prints?: Array<{ mime?: string, file_name?: string }>, na ordem de envio
 *   sender?: { name?: string, avatarUrl?: string },       remetente do webhook (sobrescreve o padrão)
 *   now?: Date|string,
 * }} [opts]
 * @returns {Array<{ username: string, avatar_url?: string, allowed_mentions: { parse: string[] }, embeds: object[], files: string[] }>}
 */
export function buildDiscordMessages(ev, { responsibleName = '', answers = [], prints = [], sender = {}, now = new Date() } = {}) {
  const kind = ev.kind === 'entrevista' ? 'entrevista' : 'allowlist';
  const approved = ev.status === 'aprovado';
  const label = approved ? 'ꪜ APROVADA' : '✘ REPROVADA';
  const age = ev.player_age == null ? '' : String(ev.player_age);
  const flags = ev.eval_flags ?? [];
  const lines = evaluationLines(kind, flags);
  const fields = kind === 'allowlist'
    ? [
      { name: '◈ Responsável', value: orEmpty(responsibleName), inline: true },
      { name: '◷ Enviada em', value: orEmpty(ev.submitted_at_text), inline: true },
      { name: '⏣ Autor (@)', value: orEmpty(ev.author_handle), inline: true },
      { name: '⌬ Discord ID', value: orEmpty(ev.player_discord_id), inline: true },
      { name: '⋈ Idade (IRL)', value: orEmpty(age), inline: true },
      { name: '✦ Personagem', value: orEmpty(ev.character_name), inline: true },
      { name: '♢ ID da AL', value: `\`${orEmpty(ev.al_id)}\``, inline: false },
      { name: '✏ Avaliação do candidato', value: lines.join('\n') || EMPTY, inline: false },
    ]
    : [
      { name: '◈ Responsável', value: orEmpty(responsibleName), inline: true },
      { name: '⏣ Autor (@)', value: orEmpty(ev.author_handle), inline: true },
      { name: '✦ Personagem', value: orEmpty(ev.character_name), inline: true },
      { name: '⌬ Discord ID', value: orEmpty(ev.player_discord_id), inline: true },
      { name: '⋈ Idade (IRL)', value: orEmpty(age), inline: true },
      { name: '◷ Data', value: orEmpty(ev.submitted_at_text), inline: true },
      { name: '✏ Avaliação', value: lines.join('\n') || EMPTY, inline: false },
    ];
  // Campos longos: se passarem dos limites do card, seguem em mensagens de continuação.
  const extra = [];
  const reason = clean(ev.reason) || autoMessage(kind, { flags, age: ev.player_age });
  if (reason) extra.push(...numbered('✉ Motivo', splitIntoChunks([reason])));
  // Decisão 4: cada tipo leva as próprias observações (na entrevista, as do checklist).
  if (clean(ev.notes)) extra.push(...numbered('✎ Observações adicionais', splitIntoChunks([ev.notes])));
  const gabarito = kind === 'entrevista'
    ? [...answers].filter((a) => a.send_to_discord).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((a) => `**${clean(a.question_text)}**${clean(a.note) ? `\n↳ ${clean(a.note)}` : ''}`)
    : [];
  extra.push(...numbered('⍍ Gabarito', splitIntoChunks(gabarito)));

  const base = {
    color: STATUS_COLORS[approved ? 'aprovado' : 'reprovado'],
    timestamp: new Date(now).toISOString(),
    footer: { text: kind === 'allowlist' ? 'Bloodlines RP · Sistema de Allowlist' : 'Bloodlines RP · Sistema de Entrevistas' },
  };
  const title = `${kind === 'allowlist' ? 'Allowlist' : 'Entrevista'} ${label}`;
  const embeds = [{ title, ...base, fields }];
  for (const f of extra) {
    let last = embeds[embeds.length - 1];
    if (last.fields.length >= DISCORD_LIMITS.fields || embedSize(last) + f.name.length + f.value.length > DISCORD_LIMITS.embed) {
      last = { title: `${title} · continuação`, ...base, fields: [] };
      embeds.push(last);
    }
    last.fields.push(f);
  }

  const files = prints.slice(0, MAX_PRINTS).map((p, i) => printFileName(i, p.mime || p.file_name));
  if (files.length) embeds[0].image = { url: `attachment://${files[0]}` };
  const username = clean(sender.name) || (kind === 'allowlist' ? 'Bloodlines RP · Allowlist' : 'Bloodlines RP · Entrevista');
  return embeds.map((embed, i) => ({
    username,
    ...(clean(sender.avatarUrl) ? { avatar_url: clean(sender.avatarUrl) } : {}),
    allowed_mentions: { parse: [] },
    embeds: [embed],
    files: i === 0 ? files : [],
  }));
}

/* ======================= Etapa 7: envio pela Edge Function enviar-discord ======================= */
/** Mensagens do envio. Iguais na Edge Function (gerada deste arquivo) e no mock. */
export const DISCORD_SEND_ERRORS = Object.freeze({
  alreadySent: 'Esta análise já foi enviada ao Discord. Confirme para enviar de novo.',
  webhook: 'Webhook inativo, removido ou de outra finalidade. Escolha outro canal.',
  noWebhook: 'Nenhum webhook configurado. Peça a um administrador para cadastrar em Configurações › Webhooks.',
  missingFunction: 'A função de envio ainda não foi instalada no Supabase. Avise a administração.',
  unreachable: 'Não foi possível falar com a função de envio (enviar-discord). Confira se ela está instalada no Supabase com esse nome exato; se estiver, tente de novo.',
  discord: (status) => `O Discord recusou o envio (HTTP ${status}). O webhook pode ter sido apagado no Discord.`,
  announcementForbidden: 'Seu cargo não permite enviar avisos.',
  announcementNotFound: 'Aviso não encontrado.',
  noBot: 'O bot do Discord ainda não foi configurado no Supabase (segredo DISCORD_BOT_TOKEN). Avise a administração.',
  nothingToSend: 'Escolha enviar no canal, no privado ou nos dois.',
  outdatedFunction: 'A função enviar-discord instalada no Supabase é de uma versão antiga e ainda não envia avisos nem reuniões. Avise a administração para colar o arquivo novo (supabase/functions/enviar-discord/index.ts) e clicar Deploy.',
  meetingForbidden: 'Seu cargo não permite avisar sobre reuniões.',
  meetingNotFound: 'Reunião não encontrada.',
  meetingClosed: 'Esta reunião já foi encerrada.',
  meetingKind: 'Tipo de mensagem da reunião desconhecido.',
  noRecipients: 'Nenhum convocado ativo para avisar. Confira os convocados da reunião.',
});
export const TEST_MESSAGE = '✓ Teste de conexão — Bloodlines RP · Central da Staff';

/** Texto gravado em discord_status (até 300 caracteres). */
export const sentStatus = (webhookName, extra = '') => `enviado para ${clean(webhookName)}${extra ? ` · ${extra}` : ''}`.slice(0, 300);

/**
 * Corpo multipart de uma mensagem de buildDiscordMessages: payload_json (sem a lista de nomes)
 * + attachments com o nome de cada arquivo. Os blobs vão em files[0], files[1]...
 * @param {{ files: string[] } & object} message
 */
export function discordPayload(message) {
  const { files = [], ...rest } = message;
  return files.length ? { ...rest, attachments: files.map((filename, id) => ({ id, filename })) } : rest;
}

/* ======================= Avisos no Discord (Decisão 11 do documento 01) ======================= */
/** Rótulos e cores por prioridade. Rótulos iguais a PRIORITIES (workflow.js) e cargos iguais a
 *  permissions.js (tests/unit/allowlist-rules.test.mjs confere): a Edge Function não importa aqueles arquivos. */
export const ANNOUNCEMENT_DISCORD = Object.freeze({
  priorities: Object.freeze({ normal: 'Normal', importante: 'Importante', urgente: 'Urgente' }),
  colors: Object.freeze({ normal: 0x5B8DEF, importante: 0xE0A43A, urgente: 0xC8365A }),
  roles: Object.freeze({
    allowlist: 'Allowlist', lore: 'Lore', suporte: 'Suporte', moderador: 'Moderador',
    head_staff: 'Head Staff', admin: 'Resp. Equipe', manager: 'Administrador', ceo: 'CEO',
  }),
});
const SITE_URL = /^https:\/\/[^\s#?]{1,300}$/;
const discordTime = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:f>`;

/** Card do aviso (canal e privado usam o mesmo). */
function announcementEmbed(a, { senderName = '', siteUrl = '', now = new Date() } = {}) {
  const { priorities, colors, roles } = ANNOUNCEMENT_DISCORD;
  const audience = a.audience_roles ?? [];
  const at = new Date(now);
  const prefix = a.priority === 'urgente' ? `${WARN} ` : a.priority === 'importante' ? '● ' : '';
  const fields = [
    { name: '◈ Prioridade', value: priorities[a.priority] ?? priorities.normal, inline: true },
    { name: '⏣ Para', value: audience.length ? audience.map((r) => roles[r] ?? r).join(', ') : 'Toda a equipe', inline: true },
    { name: '✎ Enviado por', value: orEmpty(senderName), inline: true },
  ];
  if (a.starts_at && new Date(a.starts_at) > at) fields.push({ name: '◷ Começa em', value: discordTime(a.starts_at), inline: true });
  if (a.ends_at) fields.push({ name: '◷ Válido até', value: discordTime(a.ends_at), inline: true });
  if (a.requires_ack) fields.push({ name: '✓ Confirmação', value: 'Abra o aviso na Central da Staff e clique em **Li e entendi**.', inline: false });
  const site = clean(siteUrl);
  return {
    title: `${prefix}${clean(a.title)}`.slice(0, 256),
    ...(clean(a.body) ? { description: clean(a.body).slice(0, 4096) } : {}),
    ...(SITE_URL.test(site) ? { url: `${site}#/avisos#aviso-${encodeURIComponent(a.id)}` } : {}),
    color: colors[a.priority] ?? colors.normal,
    fields,
    timestamp: at.toISOString(),
    footer: { text: 'Bloodlines RP · Avisos da Staff' },
  };
}

/**
 * IDs de cargo do Discord a marcar: os do público do aviso ("Toda a equipe" = todos os
 * cadastrados), sem repetir e só os válidos.
 * @param {string[]} audienceRoles @param {Array<{ role: string, discord_role_id: string }>} roleIds
 */
export function announcementMentions(audienceRoles = [], roleIds = []) {
  const ids = roleIds.filter((r) => !audienceRoles.length || audienceRoles.includes(r.role))
    .map((r) => clean(r.discord_role_id)).filter((id) => DISCORD_ID.test(id));
  return [...new Set(ids)];
}

/**
 * Quem recebe no privado (decisão de 30/09): membros ativos da staff com o cargo do público;
 * "Toda a equipe" = todos os ativos. Pelo cargo cadastrado no site, não pelo do servidor.
 * @param {string[]} audienceRoles @param {Array<{ discord_id: string, display_name?: string, role: string, active?: boolean }>} staff
 */
export const announcementRecipients = (audienceRoles = [], staff = []) => staff
  .filter((s) => s.active !== false && DISCORD_ID.test(s.discord_id ?? '') && (!audienceRoles.length || audienceRoles.includes(s.role)));

/**
 * Mensagem do webhook para um aviso: um card com título, texto (o Discord entende o mesmo
 * Markdown simples do site), prioridade, público e datas. Marca só os cargos de mentionRoleIds.
 * @param {{ id: string, title: string, body?: string, priority: string, audience_roles?: string[],
 *   starts_at?: string, ends_at?: string|null, requires_ack?: boolean }} a
 * @param {{ senderName?: string, sender?: { name?: string, avatarUrl?: string }, siteUrl?: string,
 *   now?: Date|string, mentionRoleIds?: string[] }} [opts]
 */
export function buildAnnouncementMessage(a, { sender = {}, mentionRoleIds = [], ...opts } = {}) {
  const ids = mentionRoleIds.filter((id) => DISCORD_ID.test(id));
  return {
    username: clean(sender.name) || 'Bloodlines RP · Avisos',
    ...(clean(sender.avatarUrl) ? { avatar_url: clean(sender.avatarUrl) } : {}),
    ...(ids.length ? { content: ids.map((id) => `<@&${id}>`).join(' ') } : {}),
    allowed_mentions: ids.length ? { parse: [], roles: ids } : { parse: [] },
    embeds: [announcementEmbed(a, opts)],
    files: [],
  };
}

/** Mensagem do bot no privado: o mesmo card, sem marcar ninguém. */
export const buildAnnouncementDm = (a, opts = {}) => ({
  content: 'Novo aviso da Central da Staff:',
  allowed_mentions: { parse: [] },
  embeds: [announcementEmbed(a, opts)],
});

/** Resumo do envio no privado para a tela. */
export function dmSummary({ sent = 0, failed = [] } = {}) {
  const total = sent + failed.length;
  if (!total) return 'Ninguém da staff tem esse cargo: nada foi enviado no privado.';
  return `Privado: ${sent} de ${total} receberam.${failed.length ? ` Não receberam: ${failed.join(', ')}.` : ''}`;
}

/* ======================= Reuniões no Discord (botões da Agenda, plano 06) ======================= */
/** Tipos de mensagem: anuncio (canal, pelo webhook de Avisos), convocacao (privado) e inicio (privado, "começou agora"). */
export const MEETING_MESSAGE_KINDS = Object.freeze(['anuncio', 'convocacao', 'inicio']);
/** Mesma expressão de DISCORD_LINK_PATTERN (js/core/agenda.js); tests/unit/agenda.test.mjs confere. */
export const MEETING_LINK = /^https:\/\/(discord\.gg\/|discord\.com\/(channels|invite)\/)[^\s]+$/;
/** Iguais a TEAM_LABELS (permissions.js); o teste confere. */
export const MEETING_TEAM_LABELS = Object.freeze({ allowlist: 'Equipe de Allowlist', lore: 'Equipe de Lore' });
export const MEETING_DISCORD = Object.freeze({
  titles: Object.freeze({ anuncio: 'Reunião', convocacao: 'Convocação', inicio: 'Reunião começou agora' }),
  colors: Object.freeze({ anuncio: 0x5B8DEF, convocacao: 0xE0A43A, inicio: 0x3DAA6A }),
  intros: Object.freeze({
    convocacao: 'Você foi convocado(a) para uma reunião da staff:',
    inicio: 'A reunião começou agora. Entre na call:',
  }),
});

export const meetingList = (m) => m.participants ?? m.meeting_participants ?? [];
const meetingLink = (m) => (MEETING_LINK.test(clean(m.discord_link)) ? clean(m.discord_link) : '');

/** Convocados em texto: cargo, equipe ou nome do membro. @param {Array<{ kind: string, value: string }>} participants */
export function meetingAudienceText(participants = [], staff = []) {
  const names = new Map(staff.map((s) => [s.discord_id, s.display_name]));
  const labels = participants.map((p) => (p.kind === 'role' ? ANNOUNCEMENT_DISCORD.roles[p.value] ?? p.value
    : p.kind === 'team' ? MEETING_TEAM_LABELS[p.value] ?? p.value : names.get(p.value) ?? 'Membro removido'));
  return labels.length ? labels.join(', ').slice(0, 1000) : 'A definir';
}

/**
 * Quem recebe no privado: membros ativos alcançados pelos convocados (cargo inteiro, tag de equipe ou o próprio membro).
 * Mesma conta de audienceOf (js/core/agenda.js).
 * @param {Array<{ kind: string, value: string }>} participants
 * @param {Array<{ discord_id: string, display_name?: string, role: string, teams?: string[], active?: boolean }>} staff
 */
export const meetingRecipients = (participants = [], staff = []) => staff.filter((s) => s.active !== false && DISCORD_ID.test(s.discord_id ?? '')
  && participants.some((p) => (p.kind === 'role' && p.value === s.role) || (p.kind === 'team' && (s.teams ?? []).includes(p.value))
    || (p.kind === 'member' && p.value === s.discord_id)));

/** Cargos do Discord a marcar no canal: só os dos cargos convocados (tag e membro não marcam ninguém). */
export const meetingMentions = (participants = [], roleIds = []) => {
  const roles = new Set(participants.filter((p) => p.kind === 'role').map((p) => p.value));
  return [...new Set(roleIds.filter((r) => roles.has(r.role)).map((r) => clean(r.discord_role_id)).filter((id) => DISCORD_ID.test(id)))];
};

/** Card da reunião (canal e privado usam o mesmo desenho). */
export function meetingEmbed(m, { kind = 'anuncio', senderName = '', staff = [], now = new Date() } = {}) {
  const ts = Math.floor(new Date(m.starts_at).getTime() / 1000);
  const link = meetingLink(m);
  const pauta = clean(m.description);
  const fields = [
    { name: '◷ Quando', value: `${formatAnalyzedAt(m.starts_at)} (Brasília) · <t:${ts}:R>`, inline: false },
    { name: '⏣ Convocados', value: meetingAudienceText(meetingList(m), staff), inline: false },
  ];
  if (link) fields.push({ name: '✆ Call no Discord', value: link, inline: false });
  if (kind === 'anuncio' && clean(senderName)) fields.push({ name: '✎ Marcado por', value: clean(senderName), inline: true });
  return {
    title: `${MEETING_DISCORD.titles[kind] ?? MEETING_DISCORD.titles.anuncio}: ${clean(m.title)}`.slice(0, 256),
    ...(pauta ? { description: `**Pauta**\n${pauta}`.slice(0, 4096) } : {}),
    ...(link ? { url: link } : {}),
    color: MEETING_DISCORD.colors[kind] ?? MEETING_DISCORD.colors.anuncio,
    fields,
    timestamp: new Date(now).toISOString(),
    footer: { text: 'Bloodlines RP · Agenda de Reuniões' },
  };
}

/** Mensagem do webhook (canal geral da staff). Marca só os cargos de mentionRoleIds. */
export function buildMeetingAnnouncement(m, { sender = {}, mentionRoleIds = [], ...opts } = {}) {
  const ids = mentionRoleIds.filter((id) => DISCORD_ID.test(id));
  return {
    username: clean(sender.name) || 'Bloodlines RP · Agenda',
    ...(clean(sender.avatarUrl) ? { avatar_url: clean(sender.avatarUrl) } : {}),
    ...(ids.length ? { content: ids.map((id) => `<@&${id}>`).join(' ') } : {}),
    allowed_mentions: ids.length ? { parse: [], roles: ids } : { parse: [] },
    embeds: [meetingEmbed(m, { ...opts, kind: 'anuncio' })],
    files: [],
  };
}

/** Mensagem do bot no privado: convocação ("convocacao") ou "começou agora" ("inicio"). Não marca ninguém. */
export const buildMeetingDm = (m, { kind = 'convocacao', ...opts } = {}) => ({
  content: MEETING_DISCORD.intros[kind] ?? MEETING_DISCORD.intros.convocacao,
  allowed_mentions: { parse: [] },
  embeds: [meetingEmbed(m, { ...opts, kind })],
});

/** Resumo do privado das reuniões para a tela. */
export function meetingDmSummary({ sent = 0, failed = [] } = {}) {
  const total = sent + failed.length;
  if (!total) return 'Nenhum convocado ativo para avisar: nada foi enviado no privado.';
  return `Privado: ${sent} de ${total} receberam.${failed.length ? ` Não receberam: ${failed.join(', ')}.` : ''}`;
}

/* ======================= Áreas da Staff no Discord (plano 07, Fase 4) ======================= */
/** Tipos de envio: canal (o bot posta no canal), dm (privado de cada um) e alinhamento (canal marcando as pessoas, com a call). */
export const AREA_MESSAGE_KINDS = Object.freeze(['canal', 'dm', 'alinhamento']);
export const AREA_MESSAGE_MAX = 2000;
export const AREA_MAX_RECIPIENTS = 100;
/** Marcações pessoais no canal: o Discord limita o texto a 2000 caracteres e cada marcação ocupa cerca de 22. */
export const AREA_MAX_MENTIONS = 60;
export const AREA_DM_CLOSED_CODE = 50007;
export const AREA_DISCORD_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não permite enviar mensagens pelas Áreas.',
  areaNotFound: 'Área não encontrada.',
  archived: 'Esta área está arquivada: só leitura.',
  kind: 'Tipo de mensagem desconhecido.',
  content: 'Escreva a mensagem.',
  contentMax: `A mensagem pode ter até ${AREA_MESSAGE_MAX} caracteres.`,
  channelId: 'ID do canal: só números, de 17 a 20 dígitos.',
  noChannel: 'Esta área não tem canal do Discord. Informe o ID do canal.',
  noRole: 'Esta área não tem cargo do Discord cadastrado para marcar.',
  callLink: 'Link da call: use um endereço discord.gg ou discord.com/channels.',
  userIds: 'Destinatários: Discord ID de 17 a 20 dígitos.',
  tooMany: `Até ${AREA_MAX_RECIPIENTS} pessoas por envio.`,
  tooManyMentions: `Para chamar mais de ${AREA_MAX_MENTIONS} pessoas no canal, marque o cargo da área.`,
  notMembers: 'Só é possível enviar para membros ativos da área.',
  noRecipients: 'Esta área não tem membros ativos para receber.',
  dmClosed: 'DMs fechadas',
  channel: (status) => `O Discord recusou o envio no canal (HTTP ${status}). Confira o ID do canal e se o bot pode enviar mensagens nele.`,
  outdatedFunction: 'A função enviar-discord instalada no Supabase é de uma versão antiga e ainda não envia mensagens das Áreas. Avise a administração para colar o arquivo novo (supabase/functions/enviar-discord/index.ts) e clicar Deploy.',
});
/** acao gravada em areas_historico (entidade "comunicacao"). */
export const AREA_HISTORY_ACTIONS = Object.freeze({ canal: 'enviou_canal', dm: 'enviou_dm', alinhamento: 'alinhamento' });

/**
 * Valida o pedido de mensagem de uma área (mesmas regras no site, no mock e na Edge Function).
 * @param {{ kind?: string, conteudo?: string, canal_id?: string, user_ids?: string[], link_call?: string }} m
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateAreaMessage(m = {}) {
  const errors = {};
  const text = String(m.conteudo ?? '').trim();
  if (!AREA_MESSAGE_KINDS.includes(m.kind)) errors.kind = AREA_DISCORD_ERRORS.kind;
  if (!text) errors.conteudo = AREA_DISCORD_ERRORS.content;
  else if (text.length > AREA_MESSAGE_MAX) errors.conteudo = AREA_DISCORD_ERRORS.contentMax;
  else if (hasEmoji(text)) errors.conteudo = NO_EMOJI_MESSAGE;
  if (clean(m.canal_id) && !DISCORD_ID.test(clean(m.canal_id))) errors.canal_id = AREA_DISCORD_ERRORS.channelId;
  if (clean(m.link_call) && !MEETING_LINK.test(clean(m.link_call))) errors.link_call = AREA_DISCORD_ERRORS.callLink;
  const ids = Array.isArray(m.user_ids) ? m.user_ids : [];
  if (ids.length > AREA_MAX_RECIPIENTS) errors.user_ids = AREA_DISCORD_ERRORS.tooMany;
  else if (ids.some((id) => !DISCORD_ID.test(String(id)))) errors.user_ids = AREA_DISCORD_ERRORS.userIds;
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Quem recebe: os pedidos que são membros ativos da área (sem repetir). Pedido vazio = a equipe toda.
 * `unknown` lista o que foi pedido e não é membro ativo (a função recusa o envio nesse caso).
 * @param {string[]} requestedIds
 * @param {Array<{ discord_id: string, display_name?: string }>} members membros ATIVOS da área
 */
export function areaRecipients(requestedIds = [], members = []) {
  const ids = [...new Set(requestedIds.map(String))];
  if (!ids.length) return { recipients: [...members], unknown: [] };
  const byId = new Map(members.map((m) => [m.discord_id, m]));
  return { recipients: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), unknown: ids.filter((id) => !byId.has(id)) };
}

/** Cor da área (#RRGGBB) como número do Discord; cor inválida = vermelho do site. */
export const areaColor = (hex) => (/^#[0-9a-fA-F]{6}$/.test(String(hex)) ? parseInt(String(hex).slice(1), 16) : 0x8B0000);

/** Card da mensagem (canal e privado usam o mesmo desenho). */
export function areaEmbed(area, { kind = 'canal', conteudo = '', senderName = '', linkCall = '', now = new Date() } = {}) {
  const call = MEETING_LINK.test(clean(linkCall)) ? clean(linkCall) : '';
  const fields = [];
  if (clean(senderName)) fields.push({ name: '✎ Enviado por', value: clean(senderName).slice(0, 256), inline: true });
  if (call) fields.push({ name: '✆ Call no Discord', value: call, inline: false });
  return {
    title: `${kind === 'alinhamento' ? 'Alinhamento' : 'Mensagem'}: ${clean(area.nome)}`.slice(0, 256),
    description: clean(conteudo).slice(0, AREA_MESSAGE_MAX),
    ...(call ? { url: call } : {}),
    color: areaColor(area.cor),
    ...(fields.length ? { fields } : {}),
    timestamp: new Date(now).toISOString(),
    footer: { text: 'Bloodlines RP · Áreas da Staff' },
  };
}

/**
 * Mensagem para o canal (kind "canal" ou "alinhamento"). Marca só o que foi pedido: o cargo da área
 * (mentionRoleId) e, no alinhamento, as pessoas (mentionUserIds). Nunca @everyone nem @here.
 * @param {{ nome: string, cor?: string }} area
 */
export function buildAreaChannelMessage(area, { kind = 'canal', mentionRoleId = '', mentionUserIds = [], ...opts } = {}) {
  const role = DISCORD_ID.test(clean(mentionRoleId)) ? clean(mentionRoleId) : '';
  const users = kind === 'alinhamento' ? [...new Set(mentionUserIds.filter((id) => DISCORD_ID.test(String(id))))] : [];
  const mentions = [...(role ? [`<@&${role}>`] : []), ...users.map((id) => `<@${id}>`)];
  return {
    ...(mentions.length ? { content: mentions.join(' ') } : {}),
    allowed_mentions: { parse: [], ...(role ? { roles: [role] } : {}), ...(users.length ? { users } : {}) },
    embeds: [areaEmbed(area, { ...opts, kind })],
  };
}

/** Mensagem do bot no privado: o mesmo card, sem marcar ninguém. */
export const buildAreaDm = (area, opts = {}) => ({
  content: `Mensagem da área ${clean(area.nome)}:`.slice(0, 200),
  allowed_mentions: { parse: [] },
  embeds: [areaEmbed(area, { ...opts, kind: 'dm' })],
});

/** Motivo curto da falha de um privado (só o código do Discord, nunca o texto interno dele). */
export const areaDmReason = (code, status) => (Number(code) === AREA_DM_CLOSED_CODE
  ? AREA_DISCORD_ERRORS.dmClosed : `Discord ${status ?? '?'}${code ? `:${code}` : ''}`);

/** Resumo do envio para a tela: "3 enviadas, 1 falhou". */
export function areaSendSummary({ enviados = 0, falhas = 0 } = {}) {
  if (!enviados && !falhas) return 'Nada foi enviado.';
  return `${enviados} ${enviados === 1 ? 'enviada' : 'enviadas'}${falhas ? `, ${falhas} ${falhas === 1 ? 'falhou' : 'falharam'}` : ''}.`;
}

/* ======================= Chamar para alinhamento (plano 11, Painel da Diretoria) ======================= */
/** Prazos do alinhamento. `days` null = sem prazo fixo. Códigos iguais ao CHECK de alinhamentos.prazo (SQL 22). */
export const ALIGNMENT_DEADLINES = Object.freeze([
  Object.freeze({ code: '1_dia', label: '1 dia', days: 1, text: 'até amanhã' }),
  Object.freeze({ code: '2_dias', label: '2 dias', days: 2, text: 'em até 2 dias' }),
  Object.freeze({ code: '7_dias', label: '7 dias', days: 7, text: 'em até 7 dias' }),
  Object.freeze({ code: 'qualquer_momento', label: 'A qualquer momento', days: null, text: 'a qualquer momento (sem prazo fixo)' }),
]);
export const ALIGNMENT_MESSAGE_MAX = 2000;
export const ALIGNMENT_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não permite chamar para alinhamento.',
  member: 'Escolha um membro ou informe o Discord ID (17 a 20 dígitos).',
  notStaff: 'Só é possível chamar membros ativos da staff.',
  self: 'Você não pode chamar a si mesmo para alinhamento.',
  message: 'Escreva a mensagem do alinhamento.',
  messageMax: `A mensagem pode ter até ${ALIGNMENT_MESSAGE_MAX} caracteres.`,
  deadline: 'Escolha o prazo do alinhamento.',
  channelId: AREA_DISCORD_ERRORS.channelId,
  callLink: AREA_DISCORD_ERRORS.callLink,
  meetingAt: 'Reunião na Agenda: escolha um dia e horário no futuro.',
  noAgenda: 'Seu cargo não permite marcar reuniões na Agenda.',
  outdatedFunction: 'A função enviar-discord instalada no Supabase é de uma versão antiga e ainda não chama para alinhamento. Avise a administração para colar o arquivo novo (supabase/functions/enviar-discord/index.ts) e clicar Deploy.',
});

export const alignmentDeadline = (code) => ALIGNMENT_DEADLINES.find((d) => d.code === code) ?? null;

/** Data limite do prazo (ISO) contando a partir de `now`; null quando é "a qualquer momento". */
export function alignmentDeadlineAt(code, now = new Date()) {
  const d = alignmentDeadline(code);
  return d?.days ? new Date(new Date(now).getTime() + d.days * 86_400_000).toISOString() : null;
}

/**
 * Valida o pedido de alinhamento (mesmas regras no site, no mock e na Edge Function).
 * @param {{ membro_id?: string, mensagem?: string, prazo?: string, canal_id?: string, link_call?: string, reuniao_em?: string }} a
 * @param {{ selfId?: string, now?: Date }} [opts]
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateAlignment(a = {}, { selfId = '', now = new Date() } = {}) {
  const errors = {};
  const member = clean(a.membro_id);
  if (!DISCORD_ID.test(member)) errors.membro_id = ALIGNMENT_ERRORS.member;
  else if (selfId && member === selfId) errors.membro_id = ALIGNMENT_ERRORS.self;
  const text = clean(a.mensagem);
  if (!text) errors.mensagem = ALIGNMENT_ERRORS.message;
  else if (text.length > ALIGNMENT_MESSAGE_MAX) errors.mensagem = ALIGNMENT_ERRORS.messageMax;
  else if (hasEmoji(text)) errors.mensagem = NO_EMOJI_MESSAGE;
  if (!alignmentDeadline(a.prazo)) errors.prazo = ALIGNMENT_ERRORS.deadline;
  if (clean(a.canal_id) && !DISCORD_ID.test(clean(a.canal_id))) errors.canal_id = ALIGNMENT_ERRORS.channelId;
  if (clean(a.link_call) && (clean(a.link_call).length > 300 || !MEETING_LINK.test(clean(a.link_call)))) errors.link_call = ALIGNMENT_ERRORS.callLink;
  if (clean(a.reuniao_em)) {
    const at = Date.parse(clean(a.reuniao_em));
    if (!Number.isFinite(at) || at <= new Date(now).getTime()) errors.reuniao_em = ALIGNMENT_ERRORS.meetingAt;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Card do alinhamento (privado e canal usam o mesmo desenho). Nunca marca ninguém por conta própria. */
export function alignmentEmbed({ mensagem = '', senderName = '', senderRole = '', prazo = '', prazoEm = null, linkCall = '', reuniaoEm = null, now = new Date() } = {}) {
  const call = MEETING_LINK.test(clean(linkCall)) ? clean(linkCall) : '';
  const deadline = alignmentDeadline(prazo);
  const role = ANNOUNCEMENT_DISCORD.roles[senderRole] ?? '';
  const fields = [];
  if (clean(senderName)) fields.push({ name: '✎ Chamado por', value: `${clean(senderName)}${role ? ` (${role})` : ''}`.slice(0, 256), inline: true });
  if (deadline) fields.push({ name: '◷ Prazo', value: `${deadline.text}${prazoEm ? ` · ${discordTime(prazoEm)}` : ''}`, inline: true });
  if (reuniaoEm) fields.push({ name: '◷ Reunião na Agenda', value: discordTime(reuniaoEm), inline: false });
  if (call) fields.push({ name: '✆ Call no Discord', value: call, inline: false });
  return {
    title: 'Alinhamento solicitado',
    description: clean(mensagem).slice(0, ALIGNMENT_MESSAGE_MAX),
    ...(call ? { url: call } : {}),
    color: 0x8B0000,
    ...(fields.length ? { fields } : {}),
    timestamp: new Date(now).toISOString(),
    footer: { text: 'Bloodlines RP · Central da Staff' },
  };
}

/** Mensagem do bot no privado de quem foi chamado. */
export const buildAlignmentDm = (opts = {}) => ({
  content: `Chamada para alinhamento: responda ${alignmentDeadline(opts.prazo)?.text ?? 'assim que puder'}.`,
  allowed_mentions: { parse: [] },
  embeds: [alignmentEmbed(opts)],
});

/** Mensagem do bot no canal: marca só a pessoa chamada (nunca @everyone nem @here). */
export function buildAlignmentChannelMessage(memberId, opts = {}) {
  const id = DISCORD_ID.test(clean(memberId)) ? clean(memberId) : '';
  return {
    ...(id ? { content: `<@${id}> chamada para alinhamento.` } : {}),
    allowed_mentions: { parse: [], ...(id ? { users: [id] } : {}) },
    embeds: [alignmentEmbed(opts)],
  };
}

export const DISCORD_ROLE_ID_ERROR = 'ID do cargo: só números, de 17 a 20 dígitos.';
/** Valida { cargo: id } (vazio = sem marcação para aquele cargo). */
export function validateDiscordRoleIds(map = {}) {
  const errors = {};
  for (const [role, id] of Object.entries(map)) {
    if (!(role in ANNOUNCEMENT_DISCORD.roles)) errors[role] = 'Cargo desconhecido.';
    else if (clean(id) && !DISCORD_ID.test(clean(id))) errors[role] = DISCORD_ROLE_ID_ERROR;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/* ======================= Validação (mesmas regras dos CHECKs do 10) ======================= */
const DISCORD_ID = /^[0-9]{17,20}$/;
/** Mesmo padrão do trigger kb_discord_webhooks_before_write. */
export const WEBHOOK_URL_PATTERN = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{20,100}$/;
const AVATAR_URL = /^https:\/\/[^/@\s]+(\/\S*)?$/;

/**
 * Valida os campos de uma análise ou entrevista. Devolve { valid, errors } (errors por campo).
 * @param {object} e
 */
export function validateAlEvaluation(e = {}) {
  const errors = {};
  if (!AL_KINDS.includes(e.kind)) errors.kind = AL_FIELD_ERRORS.kind;
  for (const f of ['al_id', 'author_handle', 'character_name', 'submitted_at_text']) {
    if (String(e[f] ?? '').length > AL_LIMITS[f]) errors[f] = AL_FIELD_ERRORS.max(AL_LIMITS[f]);
  }
  if (e.player_discord_id && !DISCORD_ID.test(e.player_discord_id)) errors.player_discord_id = AL_FIELD_ERRORS.discordId;
  if (e.player_age != null && !(Number.isInteger(e.player_age) && e.player_age >= 1 && e.player_age <= 120)) errors.player_age = AL_FIELD_ERRORS.age;
  const flags = e.eval_flags ?? [];
  if (!Array.isArray(flags) || flags.some((f) => !FLAG_ORDER.includes(f))) errors.eval_flags = AL_FIELD_ERRORS.flags;
  else if (hasFlagConflict(flags)) errors.eval_flags = ALLOWLIST_ERRORS.conflict;
  if (!AL_STATUSES.includes(e.status)) errors.status = AL_FIELD_ERRORS.status;
  else if (isMinor(e.player_age) && e.status !== 'reprovado') errors.status = ALLOWLIST_ERRORS.minor;
  for (const f of ['reason', 'notes']) {
    const v = String(e[f] ?? '');
    if (v.length > AL_LIMITS[f]) errors[f] = AL_FIELD_ERRORS.max(AL_LIMITS[f]);
    else if (hasEmoji(v)) errors[f] = NO_EMOJI_MESSAGE;
  }
  const checklist = e.checklist ?? [];
  if (!Array.isArray(checklist) || checklist.length > AL_LIMITS.checklist) errors.checklist = AL_FIELD_ERRORS.max(AL_LIMITS.checklist);
  else if (checklist.length && e.kind !== 'entrevista') errors.checklist = AL_FIELD_ERRORS.checklistOnlyInterview;
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Valida as respostas do gabarito e os participantes que acompanham uma análise.
 * @param {string} kind
 * @param {{ answers?: object[], participants?: object[] }} extra
 */
export function validateAlExtras(kind, { answers, participants } = {}) {
  const errors = {};
  if (answers?.length && kind !== 'entrevista') errors.answers = ALLOWLIST_ERRORS.answersOnlyInterview;
  else if (answers?.some((a) => !clean(a?.question_text) || clean(a.question_text).length > AL_LIMITS.question_text)) errors.answers = AL_FIELD_ERRORS.question;
  else if (answers?.some((a) => String(a.note ?? '').length > AL_LIMITS.note)) errors.answers = AL_FIELD_ERRORS.max(AL_LIMITS.note);
  else if (answers?.some((a) => hasEmoji(a.note))) errors.answers = NO_EMOJI_MESSAGE;
  if (participants?.some((p) => !DISCORD_ID.test(p?.discord_id ?? '') || !['entrevistador', 'acompanhante'].includes(p.role))) {
    errors.participants = AL_FIELD_ERRORS.participant;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Valida um print antes do envio. Devolve a mensagem de erro ou null. */
export function printError(file, currentCount = 0) {
  if (currentCount >= MAX_PRINTS) return ALLOWLIST_ERRORS.maxPrints;
  if (!PRINT_MIMES.includes(file?.type)) return AL_FIELD_ERRORS.printType;
  if (!(file.size >= 1 && file.size <= MAX_PRINT_BYTES)) return AL_FIELD_ERRORS.printSize;
  return null;
}

/**
 * Valida um webhook (seção 13.2). No cadastro a url é obrigatória; na edição, vazia = mantém.
 * @param {object} w @param {{ creating?: boolean }} [opts]
 */
export function validateWebhook(w = {}, { creating = true } = {}) {
  const errors = {};
  const name = clean(w.name);
  if (!name || name.length > 80) errors.name = AL_FIELD_ERRORS.webhookName;
  else if (hasEmoji(name)) errors.name = NO_EMOJI_MESSAGE;
  const url = clean(w.url);
  if ((creating || url) && !WEBHOOK_URL_PATTERN.test(url)) errors.url = ALLOWLIST_ERRORS.webhookUrl;
  if (!WEBHOOK_PURPOSES.includes(w.purpose)) errors.purpose = AL_FIELD_ERRORS.webhookPurpose;
  if (clean(w.channel_name).length > AL_LIMITS.channel_name) errors.channel_name = AL_FIELD_ERRORS.max(AL_LIMITS.channel_name);
  const sender = clean(w.sender_name);
  if (sender.length > AL_LIMITS.sender_name) errors.sender_name = AL_FIELD_ERRORS.max(AL_LIMITS.sender_name);
  else if (hasEmoji(sender)) errors.sender_name = NO_EMOJI_MESSAGE;
  const avatar = clean(w.sender_avatar_url);
  if (avatar && (!AVATAR_URL.test(avatar) || avatar.length > AL_LIMITS.sender_avatar_url)) errors.sender_avatar_url = AL_FIELD_ERRORS.webhookAvatar;
  return { valid: Object.keys(errors).length === 0, errors };
}
