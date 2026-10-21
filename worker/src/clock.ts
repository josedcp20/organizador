// Reloj inyectable: los tests lo sustituyen para simular el paso del tiempo.
let nowFn: () => number = () => Date.now();

export function now(): number {
  return nowFn();
}

/** Solo para tests. Sin argumento restaura el reloj real. */
export function setClock(fn?: () => number): void {
  nowFn = fn ?? (() => Date.now());
}
