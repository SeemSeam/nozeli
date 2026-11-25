// Internal implementation included once by anchored-write.cc. TxF is optional,
// deprecated by Microsoft, and experimental here. Never fall back to rename.
struct TransactionApi {
  decltype(&CreateTransaction) create;
  decltype(&CommitTransaction) commit;
  decltype(&RollbackTransaction) rollback;
  decltype(&GetTransactionInformation) information;
  decltype(&CreateFileTransactedW) open;
  decltype(&MoveFileTransactedW) move;
  TransactionApi() {
    // Retain system modules for process lifetime; never search cwd/PATH.
    const auto ktm = LoadLibraryExW(L"KtmW32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    const auto kernel = GetModuleHandleW(L"kernel32.dll");
    create = ktm ? reinterpret_cast<decltype(create)>(GetProcAddress(ktm, "CreateTransaction")) : nullptr;
    commit = ktm ? reinterpret_cast<decltype(commit)>(GetProcAddress(ktm, "CommitTransaction")) : nullptr;
    rollback = ktm ? reinterpret_cast<decltype(rollback)>(GetProcAddress(ktm, "RollbackTransaction")) : nullptr;
    information = ktm ? reinterpret_cast<decltype(information)>(GetProcAddress(ktm, "GetTransactionInformation")) : nullptr;
    open = reinterpret_cast<decltype(open)>(GetProcAddress(kernel, "CreateFileTransactedW"));
    move = reinterpret_cast<decltype(move)>(GetProcAddress(kernel, "MoveFileTransactedW"));
  }
};
TransactionApi& Transactions() {
  static TransactionApi api;
  if (!api.create || !api.commit || !api.rollback || !api.information || !api.open || !api.move)
    throw Failure("FS_TRANSACTION_UNSUPPORTED", "System transactional filesystem APIs unavailable");
  return api;
}
std::wstring PinnedDirectoryPath(HANDLE directory) {
  const auto size = GetFinalPathNameByHandleW(directory, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!size || size > 32760) throw Failure("WIN32_IO_ERROR", "Cannot resolve pinned parent", GetLastError());
  std::vector<wchar_t> buffer(size + 1);
  const auto length = GetFinalPathNameByHandleW(directory, buffer.data(), static_cast<DWORD>(buffer.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!length || length >= buffer.size()) throw Failure("WIN32_IO_ERROR", "Pinned parent path changed", GetLastError());
  std::wstring result(buffer.data(), length);
  if (result.size() < 7 || result.compare(0, 4, L"\\\\?\\") != 0 || result[5] != L':')
    throw Failure("FS_PATH_REJECTED", "Pinned parent has no local drive path");
  if (result.back() != L'\\') result += L'\\';
  return result;
}
struct Replacement {
  std::shared_ptr<DirectoryChain> chain;
  std::unique_ptr<Handle> transaction, target, candidate;
  std::wstring directory, targetName, candidateName;
  Snapshot initial{};
  Snapshot candidateInitial{};
  SecuritySnapshot security;
  bool prepared = false;
  ~Replacement() {
    candidate.reset();
    target.reset();
    if (transaction) Transactions().rollback(transaction->value);
  }
  void RequireActive() const {
    if (!transaction) throw Failure("FS_HANDLE_CLOSED", "Replacement transaction closed");
    if (!chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Pinned replacement parent changed");
  }
  std::unique_ptr<Handle> Open(const std::wstring& name, DWORD disposition, PSECURITY_DESCRIPTOR security = nullptr) {
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), security, FALSE};
    auto file = std::make_unique<Handle>(Transactions().open((directory + name).c_str(),
      GENERIC_READ | GENERIC_WRITE | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      security ? &attributes : nullptr, disposition, FILE_FLAG_OPEN_REPARSE_POINT, nullptr, transaction->value, nullptr, nullptr));
    if (file->value == INVALID_HANDLE_VALUE)
      throw Failure("FS_TRANSACTION_REFUSED", "Transactional file open refused", GetLastError());
    const auto facts = Inspect(file->value, false);
    if (facts.standard.NumberOfLinks != 1)
      throw Failure("FS_ENTRY_REJECTED", "Replacement requires a singly linked regular file");
    return file;
  }
  void Close() {
    candidate.reset();
    target.reset();
    if (!transaction) return;
    const auto success = Transactions().rollback(transaction->value);
    const auto windows = success ? 0 : GetLastError();
    DWORD outcome = 0, isolation = 0, flags = 0, timeout = 0;
    const bool known = success || (Transactions().information(transaction->value, &outcome, &isolation,
      &flags, &timeout, 0, nullptr) && outcome == TransactionOutcomeAborted);
    transaction.reset(); chain.reset();
    if (!known) {
      Failure error("FS_TRANSACTION_OUTCOME_UNKNOWN", "Rollback outcome could not be established", windows);
      error.transactionOutcome = "unknown";
      throw error;
    }
  }
};
const napi_type_tag replacementTag = {0x414dd0d1684e4c2aULL, 0x9538c32017b884e2ULL};
napi_value ReplacementClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver<Replacement>(env, info, &replacementTag)->Close(); return Undefined(env); });
}
napi_value ReplacementRead(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto tx = Receiver<Replacement>(env, info, &replacementTag);
    tx->RequireActive();
    if (tx->prepared) throw Failure("FS_TRANSACTION_STATE", "Replacement already prepared");
    const auto facts = Inspect(tx->target->value, false);
    if (!Same(tx->initial, facts, false) || facts.standard.NumberOfLinks != 1)
      throw Failure("FS_STAGE_CHANGED", "Transactional target changed");
    if (!tx->security.Matches(tx->target->value))
      throw Failure("FS_SECURITY_CHANGED", "Transactional target permissions changed");
    if (facts.standard.EndOfFile.QuadPart < 0 || facts.standard.EndOfFile.QuadPart > 1024 * 1024)
      throw Failure("FS_READ_LIMIT", "Transactional read exceeds 1048576 bytes");
    LARGE_INTEGER zero{};
    if (!SetFilePointerEx(tx->target->value, zero, nullptr, FILE_BEGIN))
      throw Failure("WIN32_IO_ERROR", "Cannot seek transactional target", GetLastError());
    std::vector<char> bytes(static_cast<size_t>(facts.standard.EndOfFile.QuadPart));
    DWORD offset = 0;
    while (offset < bytes.size()) {
      DWORD read = 0;
      if (!ReadFile(tx->target->value, bytes.data() + offset, static_cast<DWORD>(bytes.size()) - offset, &read, nullptr))
        throw Failure("WIN32_IO_ERROR", "Cannot read transactional target", GetLastError());
      if (!read) throw Failure("FS_STAGE_CHANGED", "Transactional target shortened");
      offset += read;
    }
    napi_value result;
    Check(napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result));
    return result;
  });
}
napi_value ReplacementPrepare(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto tx = Receiver<Replacement>(env, info, &replacementTag, &count, args);
    tx->RequireActive();
    if (tx->prepared) throw Failure("FS_TRANSACTION_STATE", "Replacement already prepared");
    if (tx->candidate) throw Failure("FS_TRANSACTION_STATE", "Streaming candidate already open");
    if (count != 2) throw Failure("FS_WRITE_LIMIT", "Expected candidate bytes and exclusive stage name");
    const auto name = Name(env, args[1]);
    if (CompareStringOrdinal(name.c_str(), -1, tx->targetName.c_str(), -1, TRUE) == CSTR_EQUAL)
      throw Failure("FS_NAME_REJECTED", "Stage must differ from target");
    bool typed = false; Check(napi_is_typedarray(env, args[0], &typed));
    if (!typed) throw Failure("FS_WRITE_LIMIT", "Expected non-shared Uint8Array, at most 1048576 bytes");
    void* bytes; size_t size, offsetInBuffer; napi_typedarray_type type; napi_value backing;
    Check(napi_get_typedarray_info(env, args[0], &type, &size, &bytes, &backing, &offsetInBuffer));
    bool arrayBuffer = false; Check(napi_is_arraybuffer(env, backing, &arrayBuffer));
    if (type != napi_uint8_array || !arrayBuffer || size > 1024 * 1024)
      throw Failure("FS_WRITE_LIMIT", "Expected non-shared Uint8Array, at most 1048576 bytes");
    try {
      const auto facts = Inspect(tx->target->value, false);
      if (!Same(tx->initial, facts, false) || facts.standard.NumberOfLinks != 1)
        throw Failure("FS_STAGE_CHANGED", "Transactional target changed before preparation");
      if (!tx->security.Matches(tx->target->value))
        throw Failure("FS_SECURITY_CHANGED", "Target permissions changed before preparation");
      auto stage = tx->Open(name, CREATE_NEW, tx->security.Descriptor());
      if (!tx->security.Matches(stage->value))
        throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot preserve target owner, group and DACL at creation");
      DWORD offset = 0;
      while (offset < size) {
        DWORD written = 0;
        if (!WriteFile(stage->value, static_cast<char*>(bytes) + offset, static_cast<DWORD>(size) - offset, &written, nullptr))
          throw Failure("WIN32_IO_ERROR", "Transactional stage write failed", GetLastError());
        if (!written) throw Failure("WIN32_IO_ERROR", "Transactional write made no progress");
        offset += written;
      }
      if (!FlushFileBuffers(stage->value))
        throw Failure("WIN32_IO_ERROR", "Transactional stage flush failed", GetLastError());
      // TxF handles must close before commit/rollback. The transaction must
      // retain its conflict locks through this gap; qualified in both hosts.
      stage.reset(); tx->target.reset();
      if (!Transactions().move((tx->directory + name).c_str(), (tx->directory + tx->targetName).c_str(),
          nullptr, nullptr, MOVEFILE_REPLACE_EXISTING, tx->transaction->value))
        throw Failure("FS_TRANSACTION_REFUSED", "Transactional replacement refused", GetLastError());
      tx->prepared = true;
      return Undefined(env);
    } catch (...) { tx->Close(); throw; }
  });
}
void RequireReplacementTarget(Replacement* tx) {
  tx->RequireActive();
  if (tx->prepared) throw Failure("FS_TRANSACTION_STATE", "Replacement already prepared");
  const auto facts = Inspect(tx->target->value, false);
  if (!Same(tx->initial, facts, false) || facts.standard.NumberOfLinks != 1)
    throw Failure("FS_STAGE_CHANGED", "Transactional target changed");
  if (!tx->security.Matches(tx->target->value))
    throw Failure("FS_SECURITY_CHANGED", "Transactional target permissions changed");
}
napi_value ReplacementStat(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto tx = Receiver<Replacement>(env, info, &replacementTag);
    RequireReplacementTarget(tx);
    napi_value result, value; Check(napi_create_object(env, &result));
    const auto identity = DirectoryIdentityText(tx->initial);
    Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value));
    Check(napi_set_named_property(env, result, "identity", value));
    Check(napi_create_bigint_int64(env, tx->initial.standard.EndOfFile.QuadPart, &value));
    Check(napi_set_named_property(env, result, "size", value));
    return result;
  });
}
void RequireReplacementCandidate(Replacement* tx) {
  RequireReplacementTarget(tx);
  if (!tx->candidate) throw Failure("FS_TRANSACTION_STATE", "Begin streaming candidate first");
  const auto facts = Inspect(tx->candidate->value, false);
  if (facts.standard.NumberOfLinks != 1 || facts.id.VolumeSerialNumber != tx->candidateInitial.id.VolumeSerialNumber ||
      memcmp(facts.id.FileId.Identifier, tx->candidateInitial.id.FileId.Identifier, 16) != 0)
    throw Failure("FS_STAGE_CHANGED", "Transactional candidate identity changed");
  if (!tx->security.Matches(tx->candidate->value))
    throw Failure("FS_SECURITY_CHANGED", "Transactional candidate permissions changed");
}
napi_value ReplacementReadChunk(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto tx = Receiver<Replacement>(env, info, &replacementTag, &count, args);
    RequireReplacementTarget(tx);
    if (count != 2) throw Failure("FS_READ_LIMIT", "Expected offset and chunk size");
    double values[2];
    for (size_t i = 0; i < 2; i++) {
      napi_valuetype type;
      Check(napi_typeof(env, args[i], &type));
      if (type != napi_number) throw Failure("FS_READ_LIMIT", "Expected numeric offset and size");
      Check(napi_get_value_double(env, args[i], &values[i]));
    }
    if (!(values[0] >= 0 && values[0] <= 9007199254740991.0) || values[0] != static_cast<LONGLONG>(values[0]) ||
        !(values[1] >= 1 && values[1] <= 1048576) || values[1] != static_cast<DWORD>(values[1]))
      throw Failure("FS_READ_LIMIT", "Expected safe integer offset and 1..1048576 chunk size");
    LARGE_INTEGER offset;
    offset.QuadPart = static_cast<LONGLONG>(values[0]);
    if (!SetFilePointerEx(tx->target->value, offset, nullptr, FILE_BEGIN))
      throw Failure("WIN32_IO_ERROR", "Cannot seek transactional target", GetLastError());
    std::vector<char> bytes(static_cast<size_t>(values[1]));
    DWORD read = 0;
    if (!ReadFile(tx->target->value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr))
      throw Failure("WIN32_IO_ERROR", "Cannot read transactional target", GetLastError());
    RequireReplacementTarget(tx);
    napi_value result;
    Check(napi_create_buffer_copy(env, read, bytes.data(), nullptr, &result));
    return result;
  });
}
napi_value ReplacementBeginCandidate(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    auto tx = Receiver<Replacement>(env, info, &replacementTag, &count, &arg);
    RequireReplacementTarget(tx);
    if (tx->candidate) throw Failure("FS_TRANSACTION_STATE", "Streaming candidate already open");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected exclusive candidate name");
    const auto name = Name(env, arg);
    if (CompareStringOrdinal(name.c_str(), -1, tx->targetName.c_str(), -1, TRUE) == CSTR_EQUAL)
      throw Failure("FS_NAME_REJECTED", "Candidate must differ from target");
    try {
      tx->candidate = tx->Open(name, CREATE_NEW, tx->security.Descriptor());
      tx->candidateName = name;
      tx->candidateInitial = Inspect(tx->candidate->value, false);
      RequireReplacementCandidate(tx);
      return Undefined(env);
    } catch (...) { tx->Close(); throw; }
  });
}
napi_value ReplacementWriteCandidate(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    auto tx = Receiver<Replacement>(env, info, &replacementTag, &count, &arg);
    RequireReplacementCandidate(tx);
    bool typed = false;
    if (count == 1) Check(napi_is_typedarray(env, arg, &typed));
    if (!typed) throw Failure("FS_WRITE_LIMIT", "Expected non-shared Uint8Array, at most 1048576 bytes");
    void* bytes; size_t size, offsetInBuffer; napi_typedarray_type type; napi_value backing;
    Check(napi_get_typedarray_info(env, arg, &type, &size, &bytes, &backing, &offsetInBuffer));
    bool arrayBuffer = false; Check(napi_is_arraybuffer(env, backing, &arrayBuffer));
    if (type != napi_uint8_array || !arrayBuffer || size > 1048576)
      throw Failure("FS_WRITE_LIMIT", "Expected non-shared Uint8Array, at most 1048576 bytes");
    try {
      DWORD offset = 0;
      while (offset < size) {
        DWORD written = 0;
        if (!WriteFile(tx->candidate->value, static_cast<char*>(bytes) + offset,
            static_cast<DWORD>(size) - offset, &written, nullptr))
          throw Failure("WIN32_IO_ERROR", "Transactional candidate write failed", GetLastError());
        if (!written) throw Failure("WIN32_IO_ERROR", "Transactional write made no progress");
        offset += written;
      }
      RequireReplacementCandidate(tx);
      return Undefined(env);
    } catch (...) { tx->Close(); throw; }
  });
}
napi_value ReplacementFinishCandidate(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto tx = Receiver<Replacement>(env, info, &replacementTag);
    RequireReplacementCandidate(tx);
    try {
      if (!FlushFileBuffers(tx->candidate->value))
        throw Failure("WIN32_IO_ERROR", "Transactional candidate flush failed", GetLastError());
      RequireReplacementCandidate(tx);
      tx->candidate.reset(); tx->target.reset();
      if (!Transactions().move((tx->directory + tx->candidateName).c_str(), (tx->directory + tx->targetName).c_str(),
          nullptr, nullptr, MOVEFILE_REPLACE_EXISTING, tx->transaction->value))
        throw Failure("FS_TRANSACTION_REFUSED", "Transactional replacement refused", GetLastError());
      tx->prepared = true;
      return Undefined(env);
    } catch (...) { tx->Close(); throw; }
  });
}
napi_value ReplacementPrepareDelete(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto tx = Receiver<Replacement>(env, info, &replacementTag);
    RequireReplacementTarget(tx);
    if (tx->candidate) throw Failure("FS_TRANSACTION_STATE", "Streaming candidate already open");
    try {
      // Delete the same inspected transacted HANDLE. No pathname unlink or
      // reopening a potentially replaced entry, and no attribute repair.
      FILE_DISPOSITION_INFO disposition{TRUE};
      if (!SetFileInformationByHandle(tx->target->value, FileDispositionInfo, &disposition, sizeof(disposition)))
        throw Failure("FS_TRANSACTION_REFUSED", "Transactional deletion refused", GetLastError());
      tx->target.reset();
      tx->prepared = true;
      return Undefined(env);
    } catch (...) { tx->Close(); throw; }
  });
}
napi_value ReplacementCommit(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto tx = Receiver<Replacement>(env, info, &replacementTag);
    tx->RequireActive();
    if (!tx->prepared) throw Failure("FS_TRANSACTION_STATE", "Prepare replacement before commit");
    // Allocate the result before the irreversible operation.
    napi_value result, value;
    Check(napi_create_object(env, &result));
    Check(napi_get_boolean(env, true, &value)); Check(napi_set_named_property(env, result, "committed", value));
    Check(napi_create_string_utf8(env, "namespace-not-qualified", NAPI_AUTO_LENGTH, &value));
    Check(napi_set_named_property(env, result, "durability", value));
    if (!Transactions().commit(tx->transaction->value)) {
      const auto windows = GetLastError();
      DWORD outcome = 0, isolation = 0, flags = 0, timeout = 0;
      const bool known = Transactions().information(tx->transaction->value, &outcome, &isolation,
        &flags, &timeout, 0, nullptr);
      tx->transaction.reset(); tx->chain.reset();
      Failure error(known && outcome == TransactionOutcomeAborted ? "FS_TRANSACTION_ABORTED" : "FS_TRANSACTION_OUTCOME_UNKNOWN",
        "Transaction commit failed; inspect outcome before any retry", windows);
      error.transactionOutcome = known && outcome == TransactionOutcomeCommitted ? "committed" :
        known && outcome == TransactionOutcomeAborted ? "aborted" : "unknown";
      error.committed = known && outcome == TransactionOutcomeCommitted;
      throw error;
    }
    tx->transaction.reset(); tx->chain.reset();
    return result;
  });
}
napi_value BeginReplacement(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    auto parent = Receiver<Parent>(env, info, &parentTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Write parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected existing target name");
    const auto name = Name(env, arg);
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Pinned parent changed");
    auto tx = std::make_unique<Replacement>();
    tx->chain = parent->chain;
    tx->directory = PinnedDirectoryPath(parent->chain->Parent());
    tx->targetName = name;
    tx->transaction = std::make_unique<Handle>(Transactions().create(nullptr, nullptr, 0, 0, 0, 30000,
      const_cast<wchar_t*>(L"Nozeli experimental file replacement")));
    if (tx->transaction->value == INVALID_HANDLE_VALUE)
      throw Failure("FS_TRANSACTION_UNSUPPORTED", "Cannot create filesystem transaction", GetLastError());
    tx->target = tx->Open(name, OPEN_EXISTING);
    tx->initial = Inspect(tx->target->value, false);
    tx->security = SecuritySnapshot::Read(tx->target->value);
    if (!SecuritySnapshot::Equal(tx->security.Descriptor(), tx->security.Descriptor()))
      throw Failure("FS_SECURITY_UNSUPPORTED", "Target must have an inspectable owner, group and non-null DACL");
    napi_value object;
    Check(napi_create_object(env, &object)); Check(napi_type_tag_object(env, object, &replacementTag));
    napi_property_descriptor methods[] = {
      {"read", nullptr, ReplacementRead, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stat", nullptr, ReplacementStat, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readChunk", nullptr, ReplacementReadChunk, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"beginCandidate", nullptr, ReplacementBeginCandidate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeCandidate", nullptr, ReplacementWriteCandidate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"finishCandidate", nullptr, ReplacementFinishCandidate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"prepareDelete", nullptr, ReplacementPrepareDelete, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"prepare", nullptr, ReplacementPrepare, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"commit", nullptr, ReplacementCommit, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, ReplacementClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, 10, methods));
    Check(napi_wrap(env, object, tx.get(), [](napi_env, void* data, void*) { delete static_cast<Replacement*>(data); }, nullptr, nullptr));
    tx.release(); return object;
  });
}
