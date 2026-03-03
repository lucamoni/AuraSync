# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

added_files = [
    ('static', 'static'),
    ('config.json', '.'),
    ('fixtures.json', '.'),
    ('functions.json', '.'),
    ('projects', 'projects'),
]

a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    binaries=[],
    datas=added_files,
    hiddenimports=[
        'uvicorn.logging', 
        'uvicorn.protocols', 
        'uvicorn.protocols.http', 
        'uvicorn.protocols.http.auto', 
        'uvicorn.protocols.websockets', 
        'uvicorn.protocols.websockets.auto', 
        'uvicorn.lifespan', 
        'uvicorn.lifespan.on', 
        'uvicorn.loops', 
        'uvicorn.loops.auto',
        'fastapi',
        'pyaudio',
        'numpy'
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tensorflow', 'tensorboard', 'keras', 'torch', 'pandas', 'matplotlib', 
        'sklearn', 'notebook', 'ipykernel', 'jupyter_client', 'jupyter_server', 
        'spyder', 'qt5', 'PyQt5', 'PySide2', 'docutils', 'sphinx', 'black', 
        'astroid', 'pylint', 'numba', 'llvmlite', 'dask', 'distributed', 'pyarrow'
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='AuraSyncPro',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='AuraSyncPro',
)
app = BUNDLE(
    coll,
    name='AuraSyncPro.app',
    icon='AuraSyncPro.icns',
    bundle_identifier='com.lucamoni.aurasyncpro',
    info_plist={
        'NSMicrophoneUsageDescription': 'AuraSync Pro necessita del microfono per analizzare audio in tempo reale e controllare le luci.',
        'NSHighResolutionCapable': 'True'
    },
)
