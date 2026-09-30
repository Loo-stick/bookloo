// Extraction XML minimaliste, par balayage litteral.
//
// Pas de dependance XML : les reponses Torznab et RSS sont simples et regulieres, et
// un analyseur complet serait 200 Ko de dependance pour extraire six champs. Surtout,
// le balayage litteral respecte la regle du projet — pas d'automate a quantificateurs
// sur des contenus dont on ne maitrise pas la taille.

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

export function decodeEntities(s: string): string {
  let out = s;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  // Entites numeriques (&#233;) : frequentes dans les titres de releases FR.
  return out.replace(/&#(\d{2,5});/g, (_m, code) => String.fromCharCode(Number(code)));
}

/** Decoupe un document en blocs delimites par <tag>...</tag>. */
export function extractBlocks(xml: string, tag: string): string[] {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const out: string[] = [];
  let i = 0;

  while ((i = xml.indexOf(open, i)) !== -1) {
    // On verifie que c'est bien la balise voulue et pas un prefixe (<item> vs <items>).
    const after = xml[i + open.length];
    if (after !== '>' && after !== ' ' && after !== '\n' && after !== '\r' && after !== '\t') {
      i += open.length;
      continue;
    }
    const start = xml.indexOf('>', i);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    out.push(xml.slice(start + 1, end));
    i = end + close.length;
  }
  return out;
}

/** Contenu textuel de la premiere occurrence d'une balise, CDATA compris. */
export function tagText(block: string, tag: string): string | null {
  const blocks = extractBlocks(block, tag);
  if (blocks.length === 0) return null;
  let value = blocks[0].trim();
  if (value.startsWith('<![CDATA[')) {
    const end = value.indexOf(']]>');
    value = end === -1 ? value.slice(9) : value.slice(9, end);
  }
  return decodeEntities(value.trim());
}

/** Valeur d'un attribut sur la premiere balise auto-fermante portant ce nom. */
export function attrOf(block: string, tag: string, attr: string): string | null {
  let i = 0;
  const needle = `<${tag}`;
  while ((i = block.indexOf(needle, i)) !== -1) {
    const end = block.indexOf('>', i);
    if (end === -1) return null;
    const segment = block.slice(i, end);
    const value = readAttr(segment, attr);
    if (value !== null) return value;
    i = end + 1;
  }
  return null;
}

function readAttr(segment: string, attr: string): string | null {
  const key = `${attr}="`;
  const at = segment.indexOf(key);
  if (at === -1) return null;
  const start = at + key.length;
  const end = segment.indexOf('"', start);
  return end === -1 ? null : decodeEntities(segment.slice(start, end));
}

/**
 * Attributs Torznab : `<torznab:attr name="seeders" value="12"/>`.
 * Rend une carte nom -> valeur pour un bloc <item>.
 */
export function torznabAttrs(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while ((i = block.indexOf('attr', i)) !== -1) {
    const end = block.indexOf('>', i);
    if (end === -1) break;
    const segment = block.slice(i, end);
    const name = readAttr(segment, 'name');
    const value = readAttr(segment, 'value');
    if (name && value !== null) out[name.toLowerCase()] = value;
    i = end + 1;
  }
  return out;
}
