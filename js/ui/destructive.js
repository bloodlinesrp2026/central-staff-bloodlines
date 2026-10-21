// Documento 14 · janela de confirmação das ações destrutivas (apagar, remover, cancelar, redefinir).
// Descreve o que será perdido, pede um motivo (opcional) e, nas ações de alto impacto, só libera o botão
// depois de digitar CONFIRMAR. Quem confere a permissão de verdade é o banco (funções do SQL 25).
import { h, icon, toast } from './dom.js';
import { CONFIRM_WORD, DESTRUCTIVE, REASON_MAX, confirmWordOk, validateReason } from '../core/apagar.js';

let counter = 0;

/**
 * Abre a janela. Resolve com { reason } (texto limpo ou null) quando a pessoa confirma, ou null se cancelar.
 * @param {{ title: string, lose: string, detail?: Node|string, typed?: boolean, confirmLabel: string, cancelLabel?: string }} o
 */
export function confirmDestructive({ title, lose, detail = null, typed = false, confirmLabel, cancelLabel = 'Voltar' }) {
  return new Promise((resolve) => {
    const n = ++counter;
    const titleId = `destroy-title-${n}`;
    const reasonId = `destroy-reason-${n}`;
    const typedId = `destroy-typed-${n}`;
    const reasonInput = h('textarea', { class: 'textarea', id: reasonId, rows: 2, maxlength: REASON_MAX, placeholder: 'Por que está fazendo isso? (opcional)' });
    const reasonError = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const typedInput = typed ? h('input', { class: 'input', id: typedId, autocomplete: 'off', spellcheck: 'false', placeholder: CONFIRM_WORD }) : null;
    const confirmBtn = h('button', { type: 'button', class: 'btn btn--danger-solid', id: 'destroy-confirm', disabled: typed ? true : null }, icon('trash'), confirmLabel);
    const cancelBtn = h('button', { type: 'button', class: 'btn btn--ghost', id: 'destroy-cancel', 'data-autofocus': '' }, cancelLabel);

    const dialog = h('dialog', { class: 'dialog destroy-dialog', 'aria-labelledby': titleId },
      h('h2', { class: 'dialog-title', id: titleId }, title),
      h('div', { class: 'dialog-body' },
        detail && h('div', { class: 'destroy-detail' }, detail),
        h('p', { class: 'destroy-lose' }, lose),
        h('p', { class: 'destroy-audit' }, 'A ação fica registrada na auditoria com o seu nome, o seu cargo e a data.'),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: reasonId }, 'Motivo'), reasonInput, reasonError),
        typed && h('div', { class: 'field' },
          h('label', { class: 'field-label', for: typedId }, `Para continuar, digite ${CONFIRM_WORD}`), typedInput)),
      h('div', { class: 'dialog-actions' }, cancelBtn, confirmBtn));

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const refresh = () => {
      const check = validateReason(reasonInput.value);
      reasonError.hidden = check.valid;
      reasonError.textContent = check.error ?? '';
      confirmBtn.disabled = !check.valid || (typed && !confirmWordOk(typedInput.value));
    };
    reasonInput.addEventListener('input', refresh);
    typedInput?.addEventListener('input', refresh);
    cancelBtn.addEventListener('click', () => finish(null));
    confirmBtn.addEventListener('click', () => {
      const check = validateReason(reasonInput.value);
      if (!check.valid || (typed && !confirmWordOk(typedInput.value))) { refresh(); return; }
      finish({ reason: check.reason });
    });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });

    document.body.append(dialog);
    dialog.showModal();
    cancelBtn.focus();
  });
}

/** Esconde o botão de quem não tem a permissão ou o banco ainda não tem o SQL 25 (a tela carrega as permissões uma vez só). */
export const canDestroy = (app, permission) => app.feature('apagar') && app.can(permission);

/**
 * Confirma, chama o adapter e avisa o resultado. Devolve true se a ação foi feita.
 * @param {object} app
 * @param {keyof typeof DESTRUCTIVE} kind        qual ação (textos e se pede CONFIRMAR)
 * @param {{ detail?: Node|string, call: (reason: string|null) => Promise<{ error?: object, data?: any }>, okMessage: string|((res: object) => string),
 *           onDone?: (res: object) => any }} o
 */
export async function runDestructive(app, kind, { detail = null, call, okMessage, onDone }) {
  const spec = DESTRUCTIVE[kind];
  const answer = await confirmDestructive({ ...spec, detail });
  if (!answer) return false;
  const res = await call(answer.reason);
  if (res.error) {
    const text = res.error.code === 'VALIDATION' ? (res.error.details?.errors?._ ?? res.error.message) : null;
    if (text) toast(text, 5000); else app.reportError(res.error, 'Não foi possível concluir a ação.');
    return false;
  }
  toast(typeof okMessage === 'function' ? okMessage(res) : okMessage, 4000);
  await onDone?.(res);
  return true;
}
