/**
 * #2345 — the forced file-build retry fires only on an answer that announces
 * a file for this turn, never on a list of what the agent can do. Pure
 * detector (`fileAnnouncement.ts`); the retry wiring itself is covered by
 * `v4RenderProvenanceAndExport.test.ts` (#1972, #2345 wired case).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { announcesFileBuild } from '../../packages/harness-orchestrator/src/fileAnnouncement.js';

const yes = (answers: readonly string[]) => {
  for (const answer of answers) assert.equal(announcesFileBuild(answer), true, answer);
};
const no = (answers: readonly string[]) => {
  for (const answer of answers) assert.equal(announcesFileBuild(answer), false, answer);
};

describe('file-build announcement (#2345)', () => {
  it('an announcement of this file, now, counts', () => {
    yes([
      'Ich erstelle jetzt die Excel-Datei mit allen Zeilen.',
      'Alles klar. Ich baue dir eine Arbeitsmappe mit den drei Blättern.',
      'Ich erzeuge gleich das Word-Dokument.',
      'Gerne, ich exportiere die Liste als xlsx.',
      'Ich erstelle dir jetzt eine Excel mit etwa 50 Zeilen.',
      'Ich erstelle die Dateien.',
    ]);
  });

  it('a clause after the file word does not cancel the announcement', () => {
    yes([
      'Ich erstelle jetzt die Excel-Datei – das kann einen Moment dauern.',
      'Ich erstelle jetzt die Excel-Datei, damit du sie in Excel öffnen kannst.',
      'Ich erstelle jetzt die Excel-Datei, sobald die Daten geladen sind.',
      'Ich erstelle dir eine Excel-Datei; falls etwas fehlt, sag Bescheid.',
    ]);
  });

  it('abbreviations and numbers do not split the sentence', () => {
    yes([
      'Ich erstelle jetzt die Tabelle (ca. 50 Zeilen) als Excel-Datei.',
      'Ich erstelle jetzt für den 27. November die Excel-Datei.',
      'Ich erstelle jetzt die Liste mit 1.234 Zeilen als Excel.',
    ]);
    no(['Ich erstelle dir Dateien, z. B. Excel.']);
  });

  it('future tense and English announcements count', () => {
    yes([
      'Ich werde jetzt die Excel-Datei erstellen.',
      "I'll create the Excel file now.",
      'Let me build an Excel workbook with all rows.',
      'Creating the xlsx now.',
    ]);
  });

  it('a capability list, a condition or a question does not', () => {
    no([
      'Ich bin für FAQ zuständig und erstelle bei Bedarf Excel- und Word-Dateien.',
      'Ich beantworte Fragen zu unseren Produkten und erstelle auf Wunsch Excel- oder Word-Dateien.',
      'Ich kann Fragen beantworten und erstelle Excel/Word-Dateien, wenn du sie brauchst.',
      'Ich erstelle z. B. Excel-Tabellen.',
      'Ich erstelle Excel- und Word-Dateien.',
      'Soll ich dir die Excel-Datei erstellen?',
      'Ich habe keine Datei angekündigt, sondern nur aufgezählt, was ich kann.',
      'I can create Excel and Word files for you.',
    ]);
  });

  it('look-alike words and umlauts do not trigger it', () => {
    no([
      'Ich erstelle die Dateiliste.',
      'Ich erstelle eine Wordliste.',
      'Ich erstelle dir eine Wordpress-Seite.',
      'Ich erstelle Schadensübersichten zu Schäden als Excel-Datei.',
      // Decomposed umlaut (NFD) in the marker.
      'Ich bin für FAQ zuständig und erstelle dir eine Excel.',
    ]);
  });

  it('one announcing sentence among capability sentences still counts', () => {
    yes(['Ich kann Excel- und Word-Dateien erstellen. Ich erstelle jetzt die Excel-Datei.']);
  });

  it('#2351 · an addressee with a kind of file, or "word" as a noun, is no announcement', () => {
    no([
      'Ich erstelle dir gerne Excel- oder Word-Dateien.',
      'Ich beantworte Fragen und erstelle dir Excel-Dateien.',
      'Let me make a word of caution.',
      'Let me add a word about the numbers.',
      'I can create the file if you want.',
      'Wenn du die Daten schickst, erstelle ich jetzt die Excel-Datei.',
      'Hier ist eine Übersicht, die du in Excel öffnen kannst.',
    ]);
    yes(['Ich erstelle dir die Excel-Datei.', 'Let me create a Word document with the minutes.']);
  });

  it('#2351 · a "now" word outranks an ability marker; a polite offer is no condition', () => {
    yes([
      'Ich helfe dir gern und erstelle jetzt die Excel-Datei.',
      "If you want I'll create the file.",
      'Wenn du möchtest, erstelle ich dir die Excel-Datei.',
    ]);
  });

  it('#2351 · a claim that the file is there counts', () => {
    yes([
      'Hier ist die Excel-Datei mit allen Zeilen.',
      'Anbei die Datei mit den Zahlen.',
      'Here is the Excel file with all rows.',
      "Here's your spreadsheet.",
    ]);
    no([
      'Hier ist die Übersicht.',
      'Hier ist die Datei-Übersicht der Abteilung.',
      'Ist hier die Excel-Datei gemeint?',
      // Talking about a file is no claim that one was built (review of #2351).
      'Here is a summary of the file you uploaded.',
      'Hier ist eine Zusammenfassung der Excel-Datei.',
      'Hier sind die wichtigsten Punkte aus der Datei:',
      'Anbei die Kennzahlen aus der Arbeitsmappe.',
      'Here are the totals from the spreadsheet: 42.',
      "Here's what I found in the file: nothing.",
      'Im Anhang der Mail war die Datei leider leer.',
    ]);
    yes(['Hier ist die fertige Excel-Datei.']);
  });
});
