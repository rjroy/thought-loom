export interface ClientClock { readonly at: string; readonly timeZone: string }
export function validClock(clock: ClientClock): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(clock.at);
  if (!match || !/^[A-Za-z_][A-Za-z0-9_+./-]*$/.test(clock.timeZone)) return false;
  const instant = new Date(clock.at);
  if (!Number.isFinite(instant.getTime())) return false;
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn",{timeZone:clock.timeZone,era:"short",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
    const parts = new Map(formatter.formatToParts(instant).map(part => [part.type,part.value]));
    return (["year","month","day","hour","minute","second"] as const).every((key,index) => {
      const value = Number(parts.get(key));
      return (key === "year" && parts.get("era") === "BC" ? 1-value : value) === Number(match[index+1]);
    });
  } catch { return false; }
}
export function clientClock(headers: Headers): { readonly valid: true; readonly value: ClientClock | undefined } | { readonly valid: false } {
  const at = headers.get("x-thoughtloom-client-time"), timeZone = headers.get("x-thoughtloom-client-zone");
  if (at === null && timeZone === null) return {valid:true,value:undefined};
  if (at === null || timeZone === null || at.includes(",") || timeZone.includes(",")) return {valid:false};
  const value = {at,timeZone}; return validClock(value) ? {valid:true,value} : {valid:false};
}
