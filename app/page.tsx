import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/icons";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-10">
        <span className="text-lg font-semibold tracking-tight">AutoOps</span>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <GitHubIcon className="size-4" />
          GitHub
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center sm:px-10">
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          Automate recurring AI workflows.
        </h1>

        <p className="mt-6 text-balance text-lg text-muted-foreground sm:text-xl">
          Create AI routines once. Run forever.
        </p>

        <div className="mt-10 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/dashboard" });
            }}
            className="w-full sm:w-auto"
          >
            <Button type="submit" size="lg" className="w-full sm:w-auto">
              Continue with Google
            </Button>
          </form>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            nativeButton={false}
            render={
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <GitHubIcon className="size-4" />
            GitHub
          </Button>
        </div>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground sm:px-10">
        © {new Date().getFullYear()} AutoOps. All rights reserved.
      </footer>
    </div>
  );
}
