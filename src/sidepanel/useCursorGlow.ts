import { useEffect } from 'react';

/**
 * Move o brilho que segue o cursor.
 *
 * Escreve direto em variaveis CSS do `<html>`, com um frame de rAF por lote:
 * guardar a posicao em estado do React re-renderizaria a arvore inteira a cada
 * pixel de movimento do mouse.
 *
 * A camada em si e' criada aqui e nao no HTML porque as duas paginas da
 * extensao (painel e opcoes) montam o mesmo efeito, e duplicar a `div` nos dois
 * arquivos e' o tipo de coisa que sai de sincronia.
 */
export function useCursorGlow(): void {
  useEffect(() => {
    const raiz = document.documentElement;

    let camada = document.getElementById('cursor-glow');
    let criadaAqui = false;
    if (!camada) {
      camada = document.createElement('div');
      camada.id = 'cursor-glow';
      document.body.prepend(camada);
      criadaAqui = true;
    }

    let frame = 0;
    let x = 0;
    let y = 0;

    const aplicar = () => {
      frame = 0;
      raiz.style.setProperty('--glow-x', `${x}px`);
      raiz.style.setProperty('--glow-y', `${y}px`);
    };

    const aoMover = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      raiz.style.setProperty('--glow-opacity', '1');
      if (frame === 0) frame = requestAnimationFrame(aplicar);
    };

    const aoSair = () => raiz.style.setProperty('--glow-opacity', '0');

    window.addEventListener('pointermove', aoMover, { passive: true });
    window.addEventListener('pointerleave', aoSair);
    window.addEventListener('blur', aoSair);

    return () => {
      window.removeEventListener('pointermove', aoMover);
      window.removeEventListener('pointerleave', aoSair);
      window.removeEventListener('blur', aoSair);
      if (frame !== 0) cancelAnimationFrame(frame);
      raiz.style.removeProperty('--glow-opacity');
      if (criadaAqui) camada?.remove();
    };
  }, []);
}
