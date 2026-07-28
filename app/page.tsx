import Link from "next/link";
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
          <Button
            size="lg"
            className="w-full sm:w-auto"
            render={<Link href="/dashboard" />}
          >
            Get Started
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
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
