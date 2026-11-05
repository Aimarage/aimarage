// "1 Aufgabe", "3 Aufgaben": Zahl mit passender Einzahl oder Mehrzahl.
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
