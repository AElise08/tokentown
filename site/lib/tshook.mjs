// Hook de resolução SÓ PARA TESTES (node --import ./lib/tshook.mjs --test ...).
// O código de produção usa imports relativos SEM extensão (ex.: "./season"),
// que o bundler do Next resolve, mas o runner nativo do Node (strip de tipos)
// exige extensão. Este hook resolve "./x" -> "./x.ts" quando o arquivo existe,
// deixando os testes exercitarem o store REAL sem tocar no código de produção.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.[a-z0-9]+$/i.test(spec)) {
    try {
      const u = new URL(spec + ".ts", ctx.parentURL);
      if (existsSync(fileURLToPath(u))) return { url: u.href, shortCircuit: true };
    } catch {}
  }
  return next(spec, ctx);
}
`),
  import.meta.url
);
