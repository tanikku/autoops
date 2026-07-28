export interface AIProvider {
  execute(prompt: string): Promise<string>;
}
