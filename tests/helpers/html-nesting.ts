/**
 * A small HTML content-model checker for server-rendered markup. React logs "<x> cannot be a descendant of <y> — this will cause a hydration error" in DEVELOPMENT
 * (shown as "N Issues" by the Next.js overlay), but never in the production build the e2e suite runs. This catches the common violations statically:
 *  - block-level content (div, section, ul, ol, dl, table, form, fieldset, details, summary, h1-h6, pre, p …) inside <p>
 *  - <p>/<div>/<ul>… inside <button>, an <a> inside <a>, a <button> inside <button>/<a>, <form> inside <form>, <li> outside ul/ol, <tr> outside tables
 *  - <summary> outside <details> and a <details> whose first child is not <summary>
 */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "use"]);
const NOT_IN_P = new Set(["address", "article", "aside", "blockquote", "details", "summary", "div", "dl", "fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul", "dialog"]);
const NOT_IN_INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "label"]);

export function findNestingViolations(html: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (closing) {
      const i = stack.lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const selfClosed = /\/\s*$/.test(m[3]!) || VOID.has(tag);
    const inP = stack.includes("p");
    if (inP && NOT_IN_P.has(tag)) out.push(`<${tag}> inside <p>`);
    if (stack.includes("button") && (NOT_IN_P.has(tag) || tag === "a" || tag === "button")) out.push(`<${tag}> inside <button>`);
    if (stack.includes("a") && (tag === "a" || tag === "button")) out.push(`<${tag}> inside <a>`);
    if (stack.includes("form") && tag === "form") out.push("<form> inside <form>");
    if (tag === "li" && !(stack.at(-1) === "ul" || stack.at(-1) === "ol" || stack.at(-1) === "menu")) out.push("<li> not directly inside ul/ol");
    if (tag === "summary" && stack.at(-1) !== "details") out.push("<summary> not directly inside <details>");
    if ((tag === "tr" && !stack.some((t) => ["table", "thead", "tbody", "tfoot"].includes(t))) || (tag === "td" && stack.at(-1) !== "tr")) out.push(`<${tag}> outside a table row`);
    if (stack.includes("label") && tag === "label") out.push("<label> inside <label>");
    if (NOT_IN_INTERACTIVE.has(tag) && stack.includes("button") && tag !== "button") out.push(`<${tag}> inside <button>`);
    if (!selfClosed) stack.push(tag);
  }
  return [...new Set(out)];
}
