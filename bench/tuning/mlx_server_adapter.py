"""Serve an MLX model with a LoRA adapter applied at inference, working around a
`mlx_lm.server` bug that silently ignores `--adapter-path`.

The bug is one line. `ModelProvider.__init__` registers the CLI adapter under the literal
key "default_model" (server.py:316), but `ModelProvider.load` resolves the requested model
name to a real path *before* looking the adapter up (server.py:388-389):

    model_path   = self._model_map.get(model_path, model_path)     # "default_model" -> the real path
    adapter_path = self._adapter_map.get(model_path, adapter_path)  # looks up the REAL path, always misses

So no request can reach the adapter - not by model id, and not by asking for "default_model"
either, since by then the name has already been rewritten. The flag is accepted, nothing
errors, and the server answers with the base model. Measured on mlx-lm 0.31.3 (the newest
release): with and without `--adapter-path`, 40 items produced byte-identical output in all
four scored fields.

This is the same failure shape as Ollama's importer reading a quantised checkpoint as 1.8B
bfloat16 without complaining: an option is accepted, the wrong thing is served, and only a
behavioural check catches it. Hence `--verify-adapter` below, which refuses to start unless
the served model actually differs from the base.

Fix: register the adapter under the resolved model path as well, so the lookup hits.
"""

import sys

from mlx_lm import server as mlx_server

_original_init = mlx_server.ModelProvider.__init__


def _init_with_adapter(self, cli_args):
    """Register the adapter under the resolved model path too, so the lookup hits."""
    _original_init(self, cli_args)
    adapter = getattr(cli_args, "adapter_path", None)
    if adapter:
        self._adapter_map[cli_args.model] = adapter


mlx_server.ModelProvider.__init__ = _init_with_adapter


def adapter_changes_output(model_path, adapter_path):
    """Generate once with and once without the adapter; they must differ.

    A command line is a statement of intent. This is the check that the intent took effect -
    without it an ignored adapter is indistinguishable from a tuning run that did nothing,
    and the difference is invisible in every logged field.
    """
    from mlx_lm import load, generate

    prompt = "Translate to Korean and reply in JSON: Break a leg!"
    outputs = []
    for kwargs in ({}, {"adapter_path": adapter_path}):
        model, tok = load(model_path, **kwargs)
        text = tok.apply_chat_template(
            [{"role": "user", "content": prompt}], add_generation_prompt=True, tokenize=False
        )
        outputs.append(generate(model, tok, prompt=text, max_tokens=120, verbose=False))
        del model
    return outputs[0] != outputs[1]


def main():
    # Everything except --verify-adapter is mlx_lm.server's own; its parser is built inline
    # in main() and cannot be reused, so pass the arguments straight through rather than
    # rebuilding a parser that would drift from theirs.
    argv = [a for a in sys.argv[1:] if a != "--verify-adapter"]
    verify = len(argv) != len(sys.argv[1:])

    def opt(name):
        return argv[argv.index(name) + 1] if name in argv else None

    if verify:
        model, adapter = opt("--model"), opt("--adapter-path")
        if not adapter:
            sys.exit("--verify-adapter needs --adapter-path")
        print("  verifying the adapter changes output ...", flush=True)
        if not adapter_changes_output(model, adapter):
            sys.exit("adapter produced output identical to the base model - refusing to serve")
        print("  adapter verified: output differs from the base model", flush=True)

    sys.argv = [sys.argv[0]] + argv
    mlx_server.main()


if __name__ == "__main__":
    main()
