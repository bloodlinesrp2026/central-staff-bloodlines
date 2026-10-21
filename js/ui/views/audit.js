// Etapa 11 · registro de auditoria (#/auditoria · documento 01, seção 8). Só leitura.
// Gravado pelo banco (triggers do 09), nunca pelo navegador. Avaliações aparecem sem conteúdo.
import { h, icon } from '../dom.js';
import { formatDate } from '../components.js';
import { PERMISSIONS, TEAM_LABELS, roleLabel } from '../../core/permissions.js';
import { formatDateBr } from '../../core/escalas.js';
import { renderMessage } from './message.js';

export const AUDIT_ENTITIES = Object.freeze([
  ['membro', 'Equipe'], ['permissao', 'Permissões'], ['proposta', 'Aprovação de procedimentos'],
  ['procedimento', 'Arquivamentos'], ['avaliacao', 'Avaliações'], ['periodo', 'Períodos de avaliação'], ['aviso', 'Avisos'],
  ['webhook', 'Webhooks'], ['cargo_discord', 'Cargos no Discord'], ['nome_proibido', 'Nomes proibidos'], ['pergunta', 'Gabarito'], ['personagem', 'Personagens'],
  ['checklist', 'Checklist'], ['ocorrencia', 'Ocorrências'], ['alinhamento', 'Alinhamentos'], ['sessao_entrevista', 'Sessões de entrevista'],
  ['escala', 'Escalas'], ['agenda_entrevistas', 'Agenda das entrevistas'], ['configuracao_entrevistas', 'Configurações das entrevistas'],
]);
const PAGE = 100;

const permLabel = (code) => PERMISSIONS.find((p) => p.code === code)?.description ?? code;
const teams = (t) => (t?.length ? t.map((x) => TEAM_LABELS[x] ?? x).join(', ') : 'nenhuma');

/** Frase em português para uma linha do registro. `name` traduz Discord ID em nome. */
export function describeAudit(e, name) {
  const text = describeBase(e, name);
  // Documento 14: apagar, cancelar e redefinir guardam o cargo de quem fez e o motivo no "depois".
  const why = typeof e.after?.cargo === 'string' && e.after?.motivo ? ` · motivo: ${e.after.motivo}` : '';
  return text + why;
}

/** Os dados que existiam antes de apagar/cancelar/redefinir (aparecem em "Ver os dados guardados"); null nas outras linhas. */
export function keptData(e) {
  return typeof e.after?.cargo === 'string' && e.before && Object.keys(e.before).length ? e.before : null;
}

/** "chave: valor" por linha, sem HTML (o texto entra como nó de texto). */
export function keptDataText(data) {
  const show = (v) => (v == null || v === '' ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return Object.entries(data).map(([k, v]) => `${k}: ${show(v)}`).join('\n');
}

function describeBase(e, name) {
  const b = e.before ?? {};
  const a = e.after ?? {};
  switch (e.entity) {
    case 'membro': {
      const who = a.display_name ?? b.display_name ?? name(e.entity_id);
      if (e.action === 'adicionado') return `Adicionou ${who} como ${roleLabel(a.role)}${a.teams?.length ? ` (${teams(a.teams)})` : ''}`;
      if (e.action === 'removido') return `Removeu ${who} (${roleLabel(b.role)})`;
      const parts = [];
      if (b.role !== a.role) parts.push(`cargo ${roleLabel(b.role)} → ${roleLabel(a.role)}`);
      if (JSON.stringify(b.teams ?? []) !== JSON.stringify(a.teams ?? [])) parts.push(`equipes ${teams(b.teams)} → ${teams(a.teams)}`);
      if (b.active !== a.active) parts.push(a.active ? 'reativou' : 'desativou');
      if (b.display_name !== a.display_name) parts.push(`nome "${b.display_name}" → "${a.display_name}"`);
      return `Alterou ${who}: ${parts.join('; ')}`;
    }
    case 'permissao': {
      const [role, perm] = e.entity_id.split(':');
      return `${e.action === 'ligada' ? 'Ligou' : 'Desligou'} "${permLabel(perm)}" para ${roleLabel(role)}`;
    }
    case 'proposta': return `${e.action === 'aprovada' ? 'Aprovou' : 'Recusou'} a proposta "${a.title ?? ''}" de ${name(a.author)}`;
    case 'procedimento': return `${e.action === 'arquivado' ? 'Arquivou' : 'Restaurou'} o procedimento "${a.title ?? ''}"`;
    case 'avaliacao':
      if (e.action === 'apagada') return `Apagou a avaliação de ${name(b.evaluated_id)} feita por ${name(b.evaluator_id)}`;
      return `Avaliação de ${name(a.evaluated_id)} por ${name(a.evaluator_id)} ${e.action === 'enviada' ? 'enviada' : 'arquivada'}`;
    case 'periodo': return `${e.action === 'aberto' ? 'Abriu' : 'Alterou'} o período "${a.title ?? ''}" (${formatDate(a.starts_at, { time: true })} até ${formatDate(a.ends_at, { time: true })})`;
    case 'aviso': return `${e.action === 'criado' ? 'Publicou' : 'Apagou'} o aviso "${a.title ?? b.title ?? ''}"`;
    case 'webhook': return `Webhook "${a.name ?? b.name ?? ''}" ${e.action}`;
    case 'cargo_discord': return `ID do cargo ${roleLabel(e.entity_id)} no Discord ${e.action}${a.discord_role_id ? ` (${a.discord_role_id})` : ''}`;
    case 'nome_proibido': return `Nome proibido "${a.name ?? b.name ?? ''}" ${e.action}`;
    case 'pergunta': return `Pergunta do gabarito ${e.action}: "${a.question ?? b.question ?? ''}"`;
    case 'personagem': return `Personagem "${a.character_name ?? b.character_name ?? ''}" ${e.action}`;
    case 'checklist': return `Item do checklist ${e.action}: "${a.text ?? b.text ?? ''}"`;
    case 'ocorrencia': return `Apagou a ocorrência (${b.tipo ?? ''}) sobre ${name(b.membro_id)}`;
    case 'alinhamento': return `Cancelou o alinhamento de ${b.membro_nome ?? name(b.membro_id)}`;
    case 'sessao_entrevista': return `Cancelou a sessão de entrevista de ${b.data_entrevista ? formatDateBr(b.data_entrevista) : ''} às ${b.horario ?? ''}`;
    case 'escala': return `Fechou a escala de ${b.periodo_inicio ? formatDateBr(b.periodo_inicio) : ''} a ${b.periodo_fim ? formatDateBr(b.periodo_fim) : ''}`;
    case 'agenda_entrevistas': return `Limpou a agenda das entrevistas: ${a.sessoes_apagadas ?? b.sessoes?.length ?? 0} sessão(ões) apagada(s)${a.escalas_encerradas ? ` e ${a.escalas_encerradas} escala(s) encerrada(s)` : ''}`;
    case 'configuracao_entrevistas': return e.action === 'redefinida'
      ? `Redefiniu as configurações das entrevistas ao padrão (${Object.keys(b).join(', ')})`
      : `Alterou as configurações das entrevistas (${Object.keys(b).join(', ')})`;
    default: return `${e.entity} ${e.action}`;
  }
}

export function renderAudit(app) {
  if (!app.feature('auditoria') || !app.can('auditoria.ver')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não pode ver o registro de auditoria.' });
    return null;
  }
  let alive = true;
  let entity = '';
  let rows = [];
  let names = new Map();
  const list = h('ol', { class: 'audit-list', id: 'audit-list' });
  const more = h('button', { type: 'button', class: 'btn', id: 'audit-more', hidden: true, onclick: () => load(true) }, 'Carregar mais');
  const name = (id) => names.get(id) ?? id ?? 'sistema';

  app.els.main.replaceChildren(h('div', { class: 'main-inner audit-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Auditoria'),
      h('p', { class: 'page-sub' }, 'Ações sensíveis registradas automaticamente pelo banco: quem fez, quando, o que era e o que ficou. Ninguém edita nem apaga este registro. Avaliações enviadas e arquivadas aparecem sem o conteúdo; quando uma é apagada, a cópia completa fica guardada aqui.')),
    h('section', { class: 'panel', 'aria-labelledby': 'audit-title' },
      h('h2', { class: 'block-title', id: 'audit-title' }, icon('history'), 'Registro'),
      h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Tipo'),
        h('select', { class: 'input input--sm', id: 'audit-entity', onchange: (e) => { entity = e.target.value; load(false); } },
          h('option', { value: '' }, 'Tudo'), AUDIT_ENTITIES.map(([v, t]) => h('option', { value: v }, t)))),
      list, more)));

  async function load(append) {
    const res = await app.adapter.listAudit({ entity, limit: PAGE, before: append ? rows.at(-1)?.id : null });
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar a auditoria.'); return; }
    rows = append ? [...rows, ...res.data] : res.data;
    for (const r of res.data) if (r.actor_name) names.set(r.actor, r.actor_name);
    list.replaceChildren(...(rows.length ? rows.map((e) => h('li', { class: 'audit-item' },
      h('time', { class: 'audit-when', datetime: e.at }, formatDate(e.at, { time: true })),
      h('div', { class: 'audit-body' },
        h('p', { class: 'audit-what' }, h('strong', {}, e.actor_name ?? name(e.actor)), ' · ', describeAudit(e, name)),
        keptData(e) && h('details', { class: 'audit-kept' }, h('summary', {}, 'Ver os dados guardados'), h('pre', { class: 'pre-wrap' }, keptDataText(keptData(e)))))))
      : [h('li', { class: 'staff-empty' }, 'Nada registrado ainda.')]));
    more.hidden = res.data.length < PAGE;
  }

  (async () => {
    if (app.can('equipe.ver')) {
      const staff = await app.adapter.listStaff();
      if (!staff.error) names = new Map(staff.data.map((m) => [m.discord_id, m.display_name]));
    }
    if (alive) load(false);
  })();
  return () => { alive = false; };
}
