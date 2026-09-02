#!/usr/bin/env node
import { readFileSync } from 'node:fs';

/**
 * Guarda contra encolhimento da suite de testes.
 *
 * Existe por um motivo concreto: um agente pediu para "remover complexidade
 * desnecessaria", apagou 8 arquivos de teste, e o CI passou — porque os que
 * sobraram rodaram e passaram. Contagem que so pode subir transforma isso em
 * falha visivel.
 */

const RELATORIO = process.argv[2] ?? '.vitest-report.json';
const PISO = '.github/test-floor.json';

function ler(caminho, oQueE) {
  try {
    return JSON.parse(readFileSync(caminho, 'utf8'));
  } catch (erro) {
    console.error(`Nao foi possivel ler ${oQueE} em ${caminho}: ${erro.message}`);
    process.exit(1);
  }
}

const relatorio = ler(RELATORIO, 'o relatorio do vitest');
const piso = ler(PISO, 'o piso de testes');

const testes = relatorio.numTotalTests ?? 0;
const arquivos = (relatorio.testResults ?? []).length;

const falhas = [];
if (testes < piso.minTests) {
  falhas.push(`testes: ${testes} < piso de ${piso.minTests}`);
}
if (arquivos < piso.minTestFiles) {
  falhas.push(`arquivos de teste: ${arquivos} < piso de ${piso.minTestFiles}`);
}

if (falhas.length > 0) {
  console.error('A suite de testes encolheu:\n');
  for (const falha of falhas) console.error(`  - ${falha}`);
  console.error(
    `\nSe a reducao for intencional, baixe os valores em ${PISO} no mesmo commit,` +
      '\nexplicando por que. Se nao for, restaure os testes removidos.',
  );
  process.exit(1);
}

// Cresceu: avisa para o piso ser levantado, mas nao reprova.
if (testes > piso.minTests || arquivos > piso.minTestFiles) {
  console.log(
    `Suite acima do piso (${testes}/${piso.minTests} testes, ` +
      `${arquivos}/${piso.minTestFiles} arquivos). Considere subir ${PISO}.`,
  );
} else {
  console.log(`Suite no piso: ${testes} testes em ${arquivos} arquivos.`);
}
