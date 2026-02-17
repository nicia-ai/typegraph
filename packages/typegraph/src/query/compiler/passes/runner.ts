export type CompilerPass<TState, TPassName extends string, TOutput> = Readonly<{
  name: TPassName;
  execute: (state: TState) => TOutput;
  update: (state: TState, output: TOutput) => TState;
}>;

export type CompilerPassResult<TState> = Readonly<{
  state: TState;
}>;

export function runCompilerPass<TState, TPassName extends string, TOutput>(
  state: TState,
  pass: CompilerPass<TState, TPassName, TOutput>,
): CompilerPassResult<TState> {
  const output = pass.execute(state);
  return {
    state: pass.update(state, output),
  };
}
