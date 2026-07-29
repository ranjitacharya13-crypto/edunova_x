import React from 'react';
export default function MobileMenu({show,setShow,children}) {
  return (<>
    <button onClick={()=>setShow(!show)} className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-blue-600 text-white rounded-md">☰</button>
    {show && (<div className="fixed inset-0 bg-white z-40 p-6 overflow-y-auto">
      <button onClick={()=>setShow(false)} className="text-xl font-bold mb-4">×</button>
      {children}
    </div>)}
  </>);
}