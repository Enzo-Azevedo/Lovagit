import { useMemo } from 'react';
import { parseMarkdown, type Block, type Span } from '../lib/markdown';

/**
 * Desenha o markdown que a IA respondeu.
 *
 * Nada aqui vira HTML por string: cada trecho vira elemento React. Resposta de
 * modelo e' texto de terceiro, e `dangerouslySetInnerHTML` transformaria uma
 * resposta hostil em execucao dentro da extensao.
 */

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, indice) => {
        switch (span.kind) {
          case 'strong':
            return (
              <strong key={indice} className="font-semibold text-ink-100">
                {span.text}
              </strong>
            );
          case 'em':
            return (
              <em key={indice} className="italic">
                {span.text}
              </em>
            );
          case 'code':
            return (
              <code
                key={indice}
                className="rounded bg-ink-950/80 px-1 py-0.5 font-mono text-[11px] text-lov-pink"
              >
                {span.text}
              </code>
            );
          case 'link':
            return (
              <a
                key={indice}
                href={span.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-lov-blue underline decoration-lov-blue/40 underline-offset-2 hover:decoration-lov-blue"
              >
                {span.text}
              </a>
            );
          default:
            return <span key={indice}>{span.text}</span>;
        }
      })}
    </>
  );
}

const TAMANHO_TITULO = { 1: 'text-[15px]', 2: 'text-[14px]', 3: 'text-[13px]' } as const;

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-md border border-ink-700 bg-ink-950 p-2 font-mono text-[11px] text-ink-100">
          <code>{block.content}</code>
        </pre>
      );
    case 'heading':
      return (
        <p className={`font-semibold text-ink-100 ${TAMANHO_TITULO[block.level]}`}>
          <Spans spans={block.spans} />
        </p>
      );
    case 'list':
      return block.ordered ? (
        <ol className="list-decimal space-y-0.5 pl-5">
          {block.items.map((item, indice) => (
            <li key={indice}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">
          {block.items.map((item, indice) => (
            <li key={indice}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote className="border-l-2 border-lov-orange/50 pl-2 text-ink-300 italic">
          <Spans spans={block.spans} />
        </blockquote>
      );
    case 'rule':
      return <hr className="border-ink-700" />;
    default:
      return (
        <p className="whitespace-pre-wrap break-words">
          <Spans spans={block.spans} />
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  // O texto so muda quando a mensagem muda; reparsear a cada render da arvore
  // custaria caro durante o streaming, que re-renderiza a cada token.
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-ink-100">
      {blocks.map((block, indice) => (
        <BlockView key={indice} block={block} />
      ))}
    </div>
  );
}
