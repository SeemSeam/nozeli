{
  "targets": [{
    "target_name": "nozeli_platform",
    "sources": ["platform.cc"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {"CLANG_CXX_LANGUAGE_STANDARD": "c++17", "GCC_ENABLE_CPP_EXCEPTIONS": "YES", "MACOSX_DEPLOYMENT_TARGET": "12.0"}
  }]
}
