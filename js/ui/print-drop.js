// Prints por Ctrl+V e arrastar: o que a Allowlist, a Entrevista e o Registro da Escala têm em comum.
// A lista de prints da Allowlist (varias imagens) e o print unico do Registro usam estas mesmas funcoes.
import { h, icon } from './dom.js';

/** As imagens de um evento de colar ou soltar (ignora texto e outros arquivos). */
export const imagesFrom = (transfer) => [...(transfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));

/**
 * Escuta o Ctrl+V na página inteira. `onFiles` recebe só as imagens coladas.
 * @returns {() => void} remove a escuta (chamar ao sair da tela)
 */
export function listenPaste(onFiles) {
  const onPaste = (e) => {
    const files = imagesFrom(e.clipboardData);
    if (files.length) { e.preventDefault(); onFiles(files); }
  };
  document.addEventListener('paste', onPaste);
  return () => document.removeEventListener('paste', onPaste);
}

/**
 * Print único sobre um campo de arquivo que já existe: arrastar, colar com Ctrl+V ou escolher o arquivo
 * (o campo continua sendo a fonte da verdade; a validação de quem usa não muda). Mostra miniatura com ×.
 * @param {HTMLInputElement} input campo type=file já criado
 * @returns {{ el: HTMLElement, dispose: () => void }} el vai logo depois do campo
 */
export function singlePrintPicker(input) {
  let url = null;
  const thumb = h('div', { class: 'al-thumbs al-thumbs--single', hidden: true });
  const zone = h('div', { class: 'al-drop al-drop--static', 'aria-live': 'polite' },
    icon('photo-plus'), h('span', {}, 'Arraste a imagem aqui ou cole com Ctrl+V'));
  const el = h('div', { class: 'al-prints al-prints--single' }, zone, thumb);

  function draw() {
    if (url) { URL.revokeObjectURL(url); url = null; }
    const file = input.files?.[0];
    if (!file) { thumb.hidden = true; thumb.replaceChildren(); return; }
    url = URL.createObjectURL(file);
    thumb.hidden = false;
    thumb.replaceChildren(h('div', { class: 'al-thumb' },
      h('img', { src: url, alt: `Print: ${file.name}` }),
      h('button', { type: 'button', class: 'al-thumb-x', 'aria-label': 'Remover o print', onclick: () => { input.value = ''; draw(); } }, '×')));
  }
  /** Coloca a imagem no campo, como se tivesse sido escolhida (a última substitui a anterior). */
  function set(files) {
    const file = files[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    draw();
  }

  input.addEventListener('change', draw);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); set(imagesFrom(e.dataTransfer)); });
  const stopPaste = listenPaste(set);
  return { el, dispose() { stopPaste(); if (url) URL.revokeObjectURL(url); } };
}
