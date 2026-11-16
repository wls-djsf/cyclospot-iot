(() => {
  const data=document.getElementById('data-atual'), hora=document.getElementById('hora-atual');
  const atualizar=()=>{const d=new Date();if(data)data.textContent=d.toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});if(hora)hora.textContent=d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});};
  atualizar(); if(data||hora) setInterval(atualizar,30000);
  const token=localStorage.getItem('cyclospot_token');
  const botao=document.getElementById('acao-conta');
  if(!botao)return;
  if(!token){botao.textContent='Entrar';botao.addEventListener('click',()=>location.href='login.html');return;}
  fetch('/api/me',{headers:{Authorization:'Bearer '+token}})
    .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.detail||'Sessão expirada');return d;})
    .then(me=>{const nome=document.getElementById('nome-conta');if(nome)nome.textContent=me.name;botao.textContent='Sair';botao.addEventListener('click',()=>{localStorage.removeItem('cyclospot_token');location.href='login.html';});})
    .catch(()=>{localStorage.removeItem('cyclospot_token');botao.textContent='Entrar';botao.addEventListener('click',()=>location.href='login.html');});
})();
