export default {};
export const readFileSync = () => { throw new Error('fs is not available in browser'); };
export const existsSync = () => false;
