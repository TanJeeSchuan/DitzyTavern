import { Button } from "@/components/ui/button";

export function App() {
  return (
    <main className="min-h-screen bg-background text-foreground p-6">
      <h1 className="text-2xl font-semibold tracking-tight">DitzyTavern</h1>
      <p className="mt-2 text-muted-foreground">Client shell is up.</p>
      <Button className="mt-4">Button</Button>
    </main>
  );
}
