{
  'targets': [{
    'target_name': 'nozeli_windows_read',
    'sources': ['anchored-read.cc', 'anchored-write.cc'],
    'libraries': ['advapi32.lib', 'bcrypt.lib', 'user32.lib'],
    'defines': ['NAPI_VERSION=8', 'WIN32_LEAN_AND_MEAN', 'NOMINMAX', '_WIN32_WINNT=0x0A00'],
    'msvs_configuration_attributes': {'SpectreMitigation': 'Spectre'},
    'msvs_settings': {
      'VCCLCompilerTool': {
        'ExceptionHandling': 1,
        'AdditionalOptions': ['/guard:cf', '/sdl', '/ZH:SHA_256']
      },
      'VCLinkerTool': {'AdditionalOptions': ['/DYNAMICBASE', '/guard:cf']}
    }
  }]
}
