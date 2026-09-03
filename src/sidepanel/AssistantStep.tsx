import type { ChatMessage, ToolResult } from '../lib/types';
import { TOOL_LABEL, targetOfCall, visibleResult } from './toolTrace';
import { RichText } from './ui';

/**
 * Um passo do agente: o que ela pensou, o que ela disse e o que ela fez.
 *
 * A linha da acao e' clicavel e abre o proprio resultado — o conteudo do
 * arquivo que ela leu, o retorno da busca. Antes a acao aparecia duas vezes,
 * como linha e como badge, e o conteudo nao aparecia em lugar nenhum.
 *
 * O raciocinio fica aqui, junto do passo, e nao num painel unico do turno: o
 * que interessa e' o que ela pensou ANTES desta acao, na ordem em que aconteceu.
 */
export function AssistantStep({
  message,
  results,
}: {
  message: ChatMessage;
  results: Map<string, ToolResult>;
}) {
  const chamadas = message.toolCalls ?? [];
  if (!message.content && !message.reasoning && chamadas.length === 0) return null;

  return (
    <div className="space-y-1">
      {message.reasoning && (
        <details className="rounded-md border border-ink-800 bg-ink-900/60">
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-ink-500 hover:text-ink-300">
            Raciocinio deste passo
          </summary>
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-ink-800 p-2 font-mono text-[10px] leading-relaxed text-ink-400">
            {message.reasoning}
          </div>
        </details>
      )}

      {message.content && <RichText text={message.content} />}

      {chamadas.map((call) => {
        const result = results.get(call.id);
        const erro = result?.isError === true;
        return (
          <details
            key={call.id}
            className={`rounded-md border ${
              erro ? 'border-red-500/30 bg-red-500/5' : 'border-ink-800 bg-ink-900/40'
            }`}
          >
            <summary
              className={`cursor-pointer px-2 py-1 font-mono text-[10px] ${
                erro ? 'text-red-300' : 'text-ink-400 hover:text-ink-200'
              }`}
            >
              {TOOL_LABEL[call.name] ?? call.name} {targetOfCall(call.input)}
            </summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-ink-800 p-2 font-mono text-[10px] leading-relaxed text-ink-300">
              {visibleResult(result)}
            </pre>
          </details>
        );
      })}
    </div>
  );
}
