/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

declare module 'maplibre-gl/dist/maplibre-gl.css' {
  const content: string;
  export default content;
}
