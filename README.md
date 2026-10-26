# PDV Mogo → iFood e Multipedidos

Extensão Chrome/Brave para capturar manualmente os IDs visíveis nas telas de cadastro da Mogo, comparar com o iFood ou Multipedidos e preencher os códigos após sua revisão.

## Instalação

1. Abra `chrome://extensions` (ou `brave://extensions`).
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione esta pasta.
4. Abra a Mogo, clique no ícone da extensão, escolha o tipo de cadastro e clique em **Estou na Mogo — ler esta tela**.

A captura é iniciada apenas pelo botão. A extensão não tenta identificar a Mogo pelo endereço ou IP. Repita a captura em cada tela necessária (Produtos, Adicionais, Pizzas e Sabores); os dados ficam guardados localmente no navegador.

## Códigos reconhecidos

- Produtos: ID numérico (ex.: `1629`).
- Adicionais e bordas: prefixo `AD` + ID.
- Tamanhos de pizza: prefixo `PZ` + ID.
- Sabores de pizza: prefixo `S` + ID.

Essas convenções seguem o [tutorial da Mogo para vincular produtos no iFood](https://ajuda.mogo.com.br/como-vincular-os-produtos-no-ifood/).

## Vincular no iFood

1. Capture as telas de cadastro da Mogo com os IDs visíveis.
2. Abra **Cardápio > Integração com PDV** no Portal iFood.
3. No menu da extensão, clique em **Abrir revisão do iFood**.
4. Clique em **Ler cardápio do iFood**, revise os nomes e códigos, marque somente as linhas certas e use o seletor para corrigir sugestões.
5. Clique em **Preencher selecionados** e confira/salve os campos no portal.

Correspondências são pré-selecionadas somente quando o nome é muito próximo e não há outro candidato parecido. Sugestões aproximadas aparecem desmarcadas. O botão de aplicar preenche os campos selecionados; confirme o resultado e use o controle de salvar do próprio iFood.

## Vincular no Multipedidos

1. Capture os produtos, adicionais e opções na Mogo com os IDs visíveis.
2. Abra o **Editor de Produtos** do Multipedidos ou a tela de edição de complementos/opções.
3. No menu da extensão, clique em **Abrir revisão do iFood / Multipedidos** e depois em **Ler Multipedidos**.
4. Revise as sugestões, marque somente as linhas certas e clique em **Aplicar no Multipedidos**.

No Multipedidos, tanto produtos pai quanto complementos usam o ID numérico da Mogo no campo **Código Externo** (sem os prefixos AD/PZ/S usados na vinculação com o iFood). Produtos pai são editados pelo menu do produto em **Editar > Editar códigos dos produtos**. Opções/complementos precisam estar abertos no editor para a extensão localizar o cartão e gravar o código.

## Conferência e privacidade

- Os IDs capturados ficam no armazenamento local da extensão.
- **Exportar captura para conferência** baixa um arquivo JSON para inspeção.
- **Limpar captura** remove os dados locais da Mogo.
- A extensão só lê a aba Mogo depois do botão manual e só acessa iFood ou Multipedidos quando você inicia a leitura/aplicação.

## Limite da captura

A captura lê a grade de cadastros da Mogo e associa as colunas **Id** e **Descrição**. Ao recapturar uma categoria numa grade reconhecida, os registros anteriores dessa categoria são substituídos, evitando manter resultados parciais da versão inicial. Confira o total capturado e exporte a captura para conferir os nomes e IDs antes de preencher o iFood.
