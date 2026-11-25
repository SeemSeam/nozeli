{
  'targets': [{
    'target_name': 'nozeli_windows_process',
    'sources': ['process-identity.cc'],
    'libraries': ['advapi32.lib', 'bcrypt.lib'],
    'defines': ['NAPI_VERSION=8', 'WIN32_LEAN_AND_MEAN', 'NOMINMAX', '_WIN32_WINNT=0x0A00'],
    'msvs_configuration_attributes': {'SpectreMitigation': 'Spectre'},
    'msvs_settings': {
      'VCCLCompilerTool': {
        'ExceptionHandling': 1,
        'AdditionalOptions': ['/guard:cf', '/sdl', '/ZH:SHA_256']
      },
      'VCLinkerTool': {'AdditionalOptions': ['/DYNAMICBASE', '/guard:cf']}
    }
  }, {
    'target_name': 'nozeli_windows_supervisor',
    'type': 'executable',
    'sources': ['process-supervisor.cc'],
    'libraries': ['advapi32.lib', 'bcrypt.lib'],
    'defines': ['WIN32_LEAN_AND_MEAN', 'NOMINMAX', '_WIN32_WINNT=0x0A00'],
    'msvs_configuration_attributes': {'SpectreMitigation': 'Spectre'},
    'msvs_settings': {
      'VCCLCompilerTool': {'ExceptionHandling': 1, 'AdditionalOptions': ['/guard:cf', '/sdl', '/ZH:SHA_256']},
      'VCLinkerTool': {'SubSystem': '1', 'AdditionalOptions': ['/DYNAMICBASE', '/guard:cf']}
    }
  }, {
    'target_name': 'nozeli_process_fixture',
    'type': 'executable',
    'sources': ['../../tests/fixtures/windows-process-helper.cc'],
    'defines': ['WIN32_LEAN_AND_MEAN', 'NOMINMAX', '_WIN32_WINNT=0x0A00'],
    'msvs_configuration_attributes': {'SpectreMitigation': 'Spectre'},
    'msvs_settings': {
      'VCCLCompilerTool': {'ExceptionHandling': 1, 'AdditionalOptions': ['/guard:cf', '/sdl', '/ZH:SHA_256']},
      'VCLinkerTool': {'SubSystem': '1', 'AdditionalOptions': ['/DYNAMICBASE', '/guard:cf']}
    }
  }, {
    'target_name': 'nozeli_windows_terminal',
    'type': 'executable',
    'sources': ['process-terminal.cc'],
    'defines': ['WIN32_LEAN_AND_MEAN', 'NOMINMAX', '_WIN32_WINNT=0x0A00'],
    'msvs_configuration_attributes': {'SpectreMitigation': 'Spectre'},
    'msvs_settings': {
      'VCCLCompilerTool': {'ExceptionHandling': 1, 'AdditionalOptions': ['/guard:cf', '/sdl', '/ZH:SHA_256']},
      'VCLinkerTool': {'SubSystem': '1', 'AdditionalOptions': ['/DYNAMICBASE', '/guard:cf']}
    }
  }]
}
