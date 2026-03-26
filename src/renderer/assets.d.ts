declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
