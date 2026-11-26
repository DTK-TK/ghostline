import { Badge } from "@/components/ui/badge";
import type { LiveFlag } from "@/lib/live-status";

export function FlagChips({ flags }: { flags: LiveFlag[] }) {
  if (flags.length === 0) {
    return <p className="text-base text-muted-foreground">No warning signs so far.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {flags.map((f) => (
        <li key={f.id} className="flex flex-col gap-1">
          <Badge variant="destructive" className="h-auto min-h-7 px-3 py-1 text-base whitespace-normal">
            {f.label}
          </Badge>
          {f.quote ? <q className="pl-2 text-base text-muted-foreground">{f.quote}</q> : null}
        </li>
      ))}
    </ul>
  );
}
