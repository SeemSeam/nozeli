"""Evaluation-only fail-closed guard, loaded by Python via isolated PYTHONPATH.
No candidate algorithm is replaced: prohibited network/model operations raise.
"""
import builtins
import json
import os
import socket
import sys
import time


def record(kind, detail):
    path = os.environ.get('EVALUATION_GUARD_LOG')
    if path:
        with open(path, 'a', encoding='utf-8') as stream:
            stream.write(json.dumps({'time': time.time(), 'pid': os.getpid(),
                                     'kind': kind, 'detail': str(detail)}, ensure_ascii=False) + '\n')


def audit(event, args):
    if event == 'socket.connect' and args[0].family in (socket.AF_INET, socket.AF_INET6):
        record('network_blocked', args[1])
        raise RuntimeError('Evaluation forbids network access')
    if event == 'socket.getaddrinfo':
        record('dns_blocked', args[:2])
        raise RuntimeError('Evaluation forbids DNS access')


sys.addaudithook(audit)
original_import = builtins.__import__
patching = False


def blocked_model(self, *args, **kwargs):
    record('model_blocked', type(self).__module__ + '.' + type(self).__name__)
    raise RuntimeError('Evaluation forbids model construction/inference')


def guarded_import(*args, **kwargs):
    global patching
    result = original_import(*args, **kwargs)
    if not patching:
        patching = True
        try:
            # Patch constructors, not imports or capability/list-supported-model checks.
            for name in ('fastembed', 'fastembed.rerank.cross_encoder', 'onnxruntime'):
                module = sys.modules.get(name)
                if module:
                    for clsname in ('TextEmbedding', 'SparseTextEmbedding',
                                    'LateInteractionTextEmbedding', 'TextCrossEncoder',
                                    'InferenceSession'):
                        cls = getattr(module, clsname, None)
                        if isinstance(cls, type):
                            cls.__init__ = blocked_model
        finally:
            patching = False
    return result


builtins.__import__ = guarded_import
record('guard_loaded', sys.executable)
