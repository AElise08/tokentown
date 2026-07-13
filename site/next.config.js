/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Diretório de build configurável por env. O `next dev` usa o padrão `.next`;
  // um build de produção LOCAL deve usar um distDir separado (ex.: `.next-build`)
  // pra NUNCA sobrescrever o `.next` que o dev server tem em uso — senão o dev
  // serve chunks meio-escritos e a página quebra com
  // "__webpack_modules__[moduleId] is not a function" (500). Veja `npm run build:prod`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

module.exports = nextConfig;
