declare module 'occt-import-js' {
  const occtimportjs: (opts?: { locateFile?: (path: string) => string }) => Promise<any>
  export default occtimportjs
}
