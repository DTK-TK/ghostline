import { safeNextPath, configuredPasscode } from "@/lib/dashboard-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const configured = configuredPasscode() !== null;
  const nextPath = safeNextPath(next);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="font-mono text-xl">GHOSTLINE</h1>
      {!configured ? (
        <p role="alert" className="text-base">
          The dashboard passcode is not set up on this server, so access is closed.
        </p>
      ) : (
        <form method="post" action="/api/unlock" className="flex flex-col gap-3">
          <input type="hidden" name="next" value={nextPath} />
          <label htmlFor="passcode" className="text-base">
            Family passcode
          </label>
          <Input id="passcode" name="passcode" type="password" autoComplete="current-password" required autoFocus />
          {error === "wrong" && (
            <p role="alert" className="text-base text-destructive">
              That passcode is not right. Please try again.
            </p>
          )}
          <Button type="submit">Open dashboard</Button>
        </form>
      )}
    </main>
  );
}

