export type CompilerPass<TState, TPassName extends string, TOutput> = Readonly<{
  name: TPassName;
  execute: (state: TState) => TOutput;
  update: (state: TState, output: TOutput) => TState;
}>;

export type PassSnapshot<TPassName extends string, TOutput> = Readonly<{
  name: TPassName;
  output: TOutput;
}>;

export type CompilerPassResult<
  TState,
  TPassName extends string,
  TOutput,
> = Readonly<{
  state: TState;
  snapshot: PassSnapshot<TPassName, TOutput>;
}>;

export function runCompilerPass<TState, TPassName extends string, TOutput>(
  state: TState,
  pass: CompilerPass<TState, TPassName, TOutput>,
): CompilerPassResult<TState, TPassName, TOutput> {
  const output = pass.execute(state);
  return {
    state: pass.update(state, output),
    snapshot: {
      name: pass.name,
      output,
    },
  };
}
