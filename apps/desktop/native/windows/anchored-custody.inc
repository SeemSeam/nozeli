// Included after private-file/database/directory implementations.
void CustodyAdd(nozeli_custody::Bundle* bundle,HANDLE source,nozeli_custody::Kind kind,
    const Snapshot& initial,const SecuritySnapshot* security=nullptr) {
  auto& manifest=*bundle->manifest;
  if(manifest.count>=nozeli_custody::limit)throw Failure("CUSTODY_LIMIT","Custody parent chain exceeds bound");
  if(security&&security->bytes.size()>nozeli_custody::securityLimit)throw Failure("CUSTODY_LIMIT","Custody policy exceeds bound");
  auto duplicate=std::make_unique<Handle>(INVALID_HANDLE_VALUE);
  if(!DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&duplicate->value,
      FILE_READ_ATTRIBUTES|SYNCHRONIZE|(security?READ_CONTROL:0),FALSE,0))
    throw Failure("CUSTODY_TRANSFER_FAILED","Cannot retain restricted custody handle",GetLastError());
  auto& frame=manifest.frames[manifest.count];frame.handle=reinterpret_cast<uint64_t>(duplicate->value);
  frame.kind=kind;frame.initial=initial;
  if(security){frame.securitySize=static_cast<uint32_t>(security->bytes.size());memcpy(frame.security,security->bytes.data(),frame.securitySize);}
  bundle->handles.push_back(std::move(duplicate));manifest.count++;
}
void CustodyChain(nozeli_custody::Bundle* bundle,const std::shared_ptr<DirectoryChain>& chain) {
  if(!chain||!chain->Stable())throw Failure("CUSTODY_ENTITY_CHANGED","Original custody directory chain required");
  if(chain->ancestor)CustodyChain(bundle,chain->ancestor);
  for(size_t i=0;i<chain->handles.size();i++)
    CustodyAdd(bundle,chain->handles[i]->value,nozeli_custody::Kind::directory,chain->initial[i],
      i+1==chain->handles.size()?chain->privateSecurity.get():nullptr);
  // Some private trees additionally snapshot the ancestor ACL.
  if(chain->ancestorSecurity)CustodyAdd(bundle,chain->ancestor->Parent(),nozeli_custody::Kind::directory,
    chain->ancestor->initial.back(),chain->ancestorSecurity.get());
}
napi_value CustodyClose(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{auto* bundle=Receiver<nozeli_custody::Bundle>(env,info,&nozeli_custody::tag);
    bundle->handles.clear();bundle->manifest.reset();return Undefined(env);});
}
napi_value CreateSupervisorCustody(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{
    size_t count=9;napi_value args[9];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
    if(count!=2&&count!=6&&count!=7&&count!=8)throw Failure("CUSTODY_SPEC_INVALID","Expected original host pair or complete source custody leases and source digest");
    napi_valuetype metadataType=napi_undefined;if(count>=7)Check(napi_typeof(env,args[6],&metadataType));
    const bool cold=count>=7&&metadataType!=napi_undefined;
    if(count==7&&!cold)throw Failure("CUSTODY_SPEC_INVALID","Original cold metadata parent required");
    const napi_type_tag* tags[]={&privateTreeFileTag,&databaseTag,&databaseTag,&databaseTag,&privateTreeFileTag};
    for(size_t i=0;i<(count>=6?5:2);i++){
      napi_valuetype type;Check(napi_typeof(env,args[i],&type));bool tagged=false;
      if(type==napi_object)Check(napi_check_object_type_tag(env,args[i],cold&&i==0?&nozeli_custody::coldAnchorTag:tags[i],&tagged));
      if(!tagged)throw Failure("CUSTODY_SPEC_INVALID","Original native custody leases required");
    }
    PrivateTreeFile* anchor=nullptr;DatabaseLease* database=nullptr;
    nozeli_custody::ColdAnchor* retained=nullptr;Parent* metadata=nullptr;
    std::unique_ptr<SecuritySnapshot> metadataSecurity;
    Check(napi_unwrap(env,args[1],reinterpret_cast<void**>(&database)));database->Verify();
    if(cold){
      bool tagged=false;napi_valuetype type;Check(napi_typeof(env,args[6],&type));
      if(type==napi_object)Check(napi_check_object_type_tag(env,args[6],&parentTag,&tagged));
      if(!tagged)throw Failure("CUSTODY_SPEC_INVALID","Original metadata parent lease required");
      Check(napi_unwrap(env,args[0],reinterpret_cast<void**>(&retained)));
      Check(napi_unwrap(env,args[6],reinterpret_cast<void**>(&metadata)));retained->Verify();
      if(!metadata->chain||!metadata->chain->Stable())
        throw Failure("CUSTODY_SPEC_INVALID","Private metadata parent required");
      metadataSecurity=std::make_unique<SecuritySnapshot>(SecuritySnapshot::Read(metadata->chain->Parent()));
      metadataSecurity->RequirePrivate(true);
      // Read-attributes lookup proves membership only. All custody duplicates
      // below derive from the retained original file object, never this lookup.
      auto entry=OpenChild(metadata->chain->Parent(),L"managed-host.lease",false,
        FILE_READ_ATTRIBUTES|SYNCHRONIZE,1,nullptr,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE);
      if(!Same(retained->frame.initial,Inspect(entry->value,false),false))
        throw Failure("CUSTODY_ENTITY_CHANGED","Cold anchor differs from exact metadata entry");
    }else{
      Check(napi_unwrap(env,args[0],reinterpret_cast<void**>(&anchor)));anchor->Verify();
      if(!anchor->writable||anchor->deletable)throw Failure("CUSTODY_SPEC_INVALID","Writable nondeletable host anchor required");
    }
    auto bundle=std::make_unique<nozeli_custody::Bundle>();
    const auto& anchorParent=cold?metadata->chain:anchor->parent;
    CustodyChain(bundle.get(),anchorParent);CustodyChain(bundle.get(),database->chain);
    if(cold)CustodyAdd(bundle.get(),metadata->chain->Parent(),nozeli_custody::Kind::directory,metadata->chain->initial.back(),metadataSecurity.get());
    else CustodyAdd(bundle.get(),anchor->parent->Parent(),nozeli_custody::Kind::directory,anchor->parent->initial.back(),&anchor->parentSecurity);
    CustodyAdd(bundle.get(),database->chain->Parent(),nozeli_custody::Kind::directory,database->chain->initial.back(),&database->directorySecurity);
    if(cold){
      const auto policy=SecuritySnapshot::Read(retained->file.value);
      CustodyAdd(bundle.get(),retained->file.value,nozeli_custody::Kind::anchor,retained->frame.initial,&policy);
    }else CustodyAdd(bundle.get(),anchor->file->value,nozeli_custody::Kind::anchor,anchor->initial,&anchor->security);
    CustodyAdd(bundle.get(),database->file->value,nozeli_custody::Kind::database,database->initial,&database->fileSecurity);
    if(count>=6){
      napi_valuetype digestType;Check(napi_typeof(env,args[5],&digestType));
      if(digestType!=napi_string)throw Failure("CUSTODY_SPEC_INVALID","Source SHA-256 required");
      size_t digestLength=0;Check(napi_get_value_string_utf8(env,args[5],nullptr,0,&digestLength));
      if(digestLength!=64)throw Failure("CUSTODY_SPEC_INVALID","Source SHA-256 must contain 64 lowercase hex digits");
      char digest[65]{};Check(napi_get_value_string_utf8(env,args[5],digest,sizeof(digest),&digestLength));
      const std::string hex="0123456789abcdef";
      for(size_t i=0;i<32;i++){
        const auto high=hex.find(digest[i*2]),low=hex.find(digest[i*2+1]);
        if(high==std::string::npos||low==std::string::npos)throw Failure("CUSTODY_SPEC_INVALID","Invalid source SHA-256");
        bundle->manifest->sourceSha256[i]=static_cast<BYTE>(high*16+low);
      }
      DatabaseLease* catalog=nullptr;DatabaseLease* project=nullptr;PrivateTreeFile* manifest=nullptr;
      Check(napi_unwrap(env,args[2],reinterpret_cast<void**>(&catalog)));Check(napi_unwrap(env,args[3],reinterpret_cast<void**>(&project)));
      Check(napi_unwrap(env,args[4],reinterpret_cast<void**>(&manifest)));
      catalog->Verify();project->Verify();manifest->Verify();
      if(cold&&!Same(metadata->chain->initial.back(),manifest->parent->initial.back(),true))
        throw Failure("CUSTODY_ENTITY_CHANGED","Cold metadata parent differs from project manifest parent");
      if(database->name!=L"ui.sqlite"||catalog->name!=L"catalog.sqlite"||project->name!=L"project.sqlite"||manifest->writable||manifest->deletable)
        throw Failure("CUSTODY_SPEC_INVALID","Exact source database roles and immutable manifest lease required");
      for(auto* source:{catalog,project}){
        CustodyChain(bundle.get(),source->chain);
        CustodyAdd(bundle.get(),source->chain->Parent(),nozeli_custody::Kind::directory,source->chain->initial.back(),&source->directorySecurity);
        CustodyAdd(bundle.get(),source->file->value,source==catalog?nozeli_custody::Kind::catalog:nozeli_custody::Kind::projectDatabase,source->initial,&source->fileSecurity);
      }
      CustodyChain(bundle.get(),manifest->parent);
      CustodyAdd(bundle.get(),manifest->parent->Parent(),nozeli_custody::Kind::directory,manifest->parent->initial.back(),&manifest->parentSecurity);
      CustodyAdd(bundle.get(),manifest->file->value,nozeli_custody::Kind::projectManifest,manifest->initial,&manifest->security);
      catalog->Verify();project->Verify();manifest->Verify();
    }
    if(count==8){
      bool tagged=false;napi_valuetype type;Check(napi_typeof(env,args[7],&type));
      if(type==napi_object)Check(napi_check_object_type_tag(env,args[7],&parentTag,&tagged));
      if(!tagged)throw Failure("CUSTODY_SPEC_INVALID","Original private owner home parent required");
      Parent* home=nullptr;Check(napi_unwrap(env,args[7],reinterpret_cast<void**>(&home)));
      if(!home->chain||!home->chain->Stable())throw Failure("CUSTODY_ENTITY_CHANGED","Original owner home closed or changed");
      const auto policy=SecuritySnapshot::Read(home->chain->Parent());policy.RequirePrivate(true);
      CustodyChain(bundle.get(),home->chain);
      CustodyAdd(bundle.get(),home->chain->Parent(),nozeli_custody::Kind::ownerHome,home->chain->initial.back(),&policy);
      if(!home->chain->Stable())throw Failure("CUSTODY_ENTITY_CHANGED","Owner home changed during custody transfer");
    }
    bundle->Verify();if(cold)retained->Verify();else anchor->Verify();database->Verify();
    napi_value object;Check(napi_create_object(env,&object));Check(napi_type_tag_object(env,object,&nozeli_custody::tag));
    napi_property_descriptor method={"close",nullptr,CustodyClose,nullptr,nullptr,nullptr,napi_default,nullptr};
    Check(napi_define_properties(env,object,1,&method));
    Check(napi_wrap(env,object,bundle.get(),[](napi_env,void* data,void*){delete static_cast<nozeli_custody::Bundle*>(data);},nullptr,nullptr));
    bundle.release();return object;
  });
}
